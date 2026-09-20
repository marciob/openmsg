// The connection of one gateway to the relay of its team.
//
// The gateway keeps this connection open, and the relay pushes a message into
// it. The command line opens the same connection for a moment when it sends.
import { randomUUID } from "node:crypto";
import { canonicalBytes } from "./canonical.mjs";
import * as identity from "./identity.mjs";
import * as device from "./device.mjs";
import { connect } from "./wsframe.mjs";
import { settings } from "./settings.mjs";
import { isLoopback } from "./relay.mjs";
import fs from "node:fs";

export const HELLO_TIMEOUT_MS = 10_000;
export const ANSWER_TIMEOUT_MS = 20_000;

// The hello proves the key of this owner. The relay needs no directory,
// because the owner id comes from the two public keys.
function hello() {
  const signer = device.signer();
  const me = signer.owner;
  // `keys` are the public keys of the owner. The relay reads the owner id
  // from them, and it verifies a delegation against them. It needs no
  // directory, and it learns nothing that is not public.
  const body = {
    type: "hello",
    version: 2,
    owner: me.ownerId,
    keys: me.keys,
    at: new Date().toISOString(),
    nonce: randomUUID(),
    ...(signer.delegation ? { delegation: signer.delegation } : {}),
  };
  return {
    ...body,
    signature: {
      alg: "Ed25519",
      by: me.ownerId,
      device: signer.device,
      value: signer.sign(canonicalBytes(body)).toString("base64url"),
    },
  };
}

// A relay on another machine gets a connection with TLS. Without it, the
// hello of this owner and the addresses of every message travel in the open,
// and rule 4.2 of the spec asks for TLS.
function tlsFor(url) {
  const address = new URL(url);
  if (address.protocol === "wss:") {
    const ca = settings().relayCa;
    return ca ? { ca: fs.readFileSync(ca) } : {};
  }
  if (isLoopback(address.hostname) || settings().relayInsecure) return {};
  throw new Error(
    `${url} has no TLS, and it is not on this machine. Use a wss:// address, ` +
      "or say that you accept it: openmsg relay use <url> --insecure",
  );
}

export async function open(url, handlers = {}) {
  const connection = await connect(url, { tls: tlsFor(url) });
  // key -> { resolve, keep }. A question with one answer removes its waiter
  // when the answer arrives. A question that every machine of an owner
  // answers keeps its waiter until the window closes.
  const waiting = new Map();
  const fire = (key, frame) => {
    const held = waiting.get(key);
    if (!held) return false;
    held.resolve(frame);
    if (!held.keep) waiting.delete(key);
    return true;
  };
  const link = {
    url,
    connection,
    owner: identity.load().ownerId,
    closed: false,
    send,
    routing,
    ack,
    publishRecord,
    fetchDirectory,
    close: () => {
      link.closed = true;
      connection.close();
    },
  };

  connection.on("message", (text) => {
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (frame.type === "dir-stored" || frame.type === "dir-refused") {
      if (fire(`dir:${frame.project}:${frame.kind}`, frame)) return;
    }
    if (frame.type === "dir-records" && fire(`fetch:${frame.id}`, frame)) return;
    if ((frame.type === "stored" || frame.type === "refused") && fire(`send:${frame.messageId}`, frame)) return;
    if (frame.type === "routing-answer" && fire(`routing:${frame.id}`, frame)) return;
    // The link goes to the handler. A frame can arrive before open() gives
    // the link back to its caller, and a handler that waits for that variable
    // sends nothing.
    if (frame.type === "deliver") handlers.onDeliver?.(frame, link);
    else if (frame.type === "receipt") handlers.onReceipt?.(frame, link);
    else if (frame.type === "routing-request") handlers.onRoutingRequest?.(frame, link);
    else if (frame.type === "welcome") handlers.onWelcome?.(frame, link);
    else if (frame.type === "error") handlers.onError?.(frame, link);
  });
  connection.on("close", () => {
    link.closed = true;
    for (const held of waiting.values()) held.resolve({ type: "refused", reason: "the relay closed the connection" });
    waiting.clear();
    handlers.onClose?.();
  });

  const welcome = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the relay at ${url} sent no welcome`)), HELLO_TIMEOUT_MS);
    const first = (text) => {
      let frame;
      try {
        frame = JSON.parse(text);
      } catch {
        return;
      }
      if (frame.type !== "welcome" && frame.type !== "error") return;
      clearTimeout(timer);
      connection.off("message", first);
      if (frame.type === "error") reject(new Error(`the relay refused the hello: ${frame.error}`));
      else resolve(frame);
    };
    connection.on("message", first);
  });
  connection.send(JSON.stringify(hello()));
  link.welcome = await welcome;
  return link;

  function expect(key, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(key);
        resolve({ type: "refused", reason: "the relay did not answer" });
      }, timeoutMs);
      waiting.set(key, {
        keep: false,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
    });
  }

  // Every machine of one owner answers a question about routing. The window
  // starts with the first answer, and the others have that long to arrive.
  function expectMany(key, { timeoutMs, graceMs = 400 }) {
    return new Promise((resolve) => {
      const found = [];
      let grace = null;
      const done = () => {
        clearTimeout(outer);
        clearTimeout(grace);
        waiting.delete(key);
        resolve(found);
      };
      const outer = setTimeout(done, timeoutMs);
      waiting.set(key, {
        keep: true,
        resolve: (frame) => {
          found.push(frame);
          clearTimeout(grace);
          grace = setTimeout(done, graceMs);
        },
      });
    });
  }

  // It gives back the answer of the relay, and not the answer of the
  // receiver. "stored" says that the relay holds the message on its disk.
  async function send(wire) {
    const answer = expect(`send:${wire.messageId}`, ANSWER_TIMEOUT_MS);
    connection.send(JSON.stringify({ type: "send", wire }));
    return answer;
  }

  // It gives every answer, one for each machine of that owner that is
  // online, and an empty list when none is.
  async function routing(owner, project, request) {
    const id = randomUUID();
    const answers = expectMany(`routing:${id}`, { timeoutMs: ANSWER_TIMEOUT_MS });
    connection.send(JSON.stringify({ type: "routing-request", to: owner, id, project, request }));
    return answers;
  }

  async function publishRecord(record) {
    const answer = expect(`dir:${record.project}:${record.kind}`, ANSWER_TIMEOUT_MS);
    connection.send(JSON.stringify({ type: "dir-publish", record }));
    return answer;
  }

  async function fetchDirectory(project) {
    const id = randomUUID();
    const answer = expect(`fetch:${id}`, ANSWER_TIMEOUT_MS);
    connection.send(JSON.stringify({ type: "dir-fetch", id, project }));
    return answer;
  }

  function ack(messageId, to, status, reason = null) {
    connection.send(JSON.stringify({ type: "ack", messageId, to, status, reason }));
  }
}

// The gateway keeps the connection. A relay that stops, or a network that
// fails, gives a wait that grows, and the gateway tries again.
export async function keep(url, handlers = {}) {
  let link = null;
  let stopped = false;
  let wait = 1000;
  const holder = {
    get link() {
      return link;
    },
    stop() {
      stopped = true;
      link?.close();
    },
  };
  const again = async () => {
    if (stopped) return;
    try {
      link = await open(url, { ...handlers, onClose: () => {
        handlers.onClose?.();
        link = null;
        if (!stopped) setTimeout(again, wait);
      } });
      wait = 1000;
      handlers.onOpen?.(link);
    } catch (e) {
      handlers.onError?.({ error: e.message });
      wait = Math.min(wait * 2, 60_000);
      if (!stopped) setTimeout(again, wait);
    }
  };
  await again();
  return holder;
}
