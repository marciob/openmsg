// The connection of one gateway to the relay of its team.
//
// The gateway keeps this connection open, and the relay pushes a message into
// it. The command line opens the same connection for a moment when it sends.
import { randomUUID } from "node:crypto";
import { canonicalBytes } from "./canonical.mjs";
import * as identity from "./identity.mjs";
import { connect } from "./wsframe.mjs";

export const HELLO_TIMEOUT_MS = 10_000;
export const ANSWER_TIMEOUT_MS = 20_000;

// The hello proves the key of this owner. The relay needs no directory,
// because the owner id comes from the two public keys.
function hello() {
  const me = identity.load();
  const body = {
    type: "hello",
    version: 2,
    owner: me.ownerId,
    keys: me.keys,
    at: new Date().toISOString(),
    nonce: randomUUID(),
  };
  return {
    ...body,
    signature: { alg: "Ed25519", by: me.ownerId, value: identity.sign(canonicalBytes(body)).toString("base64url") },
  };
}

export async function open(url, handlers = {}) {
  const connection = await connect(url);
  const waiting = new Map();
  const link = {
    url,
    connection,
    owner: identity.load().ownerId,
    closed: false,
    send,
    routing,
    ack,
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
    const key = frame.type === "stored" || frame.type === "refused" ? `send:${frame.messageId}` : null;
    if (key && waiting.has(key)) {
      waiting.get(key)(frame);
      waiting.delete(key);
      return;
    }
    if (frame.type === "routing-answer" && waiting.has(`routing:${frame.id}`)) {
      waiting.get(`routing:${frame.id}`)(frame);
      waiting.delete(`routing:${frame.id}`);
      return;
    }
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
    for (const resolve of waiting.values()) resolve({ type: "refused", reason: "the relay closed the connection" });
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
      waiting.set(key, (frame) => {
        clearTimeout(timer);
        resolve(frame);
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

  async function routing(owner, project, request) {
    const id = randomUUID();
    const answer = expect(`routing:${id}`, ANSWER_TIMEOUT_MS);
    connection.send(JSON.stringify({ type: "routing-request", to: owner, id, project, request }));
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
