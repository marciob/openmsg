// The relay: one server for a team. Every gateway keeps a connection to it,
// and no laptop needs an open port.
//
// The relay carries sealed bytes. It cannot read a message, and this file
// holds no key that opens one. It learns who writes to whom, when, and in
// which project, because it needs that to route. The product must say so.
//
// It stores a message for a receiver that is offline, with a bound on the
// size, on the number, and on the age. The sender keeps its own copy until a
// receipt arrives, so one loss on one side does not lose the message.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { canonicalBytes } from "./canonical.mjs";
import { ownerIdOf, publicKeyOf } from "./identity.mjs";
import { accepts, handshake } from "./wsframe.mjs";
import crypto from "node:crypto";

export const LIMITS = {
  messageBytes: 256 * 1024,
  perOwner: 200,
  ageMs: 7 * 24 * 3600 * 1000,
  helloWindowMs: 120_000,
};

export function home() {
  return process.env.OPENMSG_RELAY_HOME ?? path.join(os.homedir(), ".openmsg-relay");
}

function dir(...parts) {
  return path.join(home(), ...parts);
}

// --- the durable store -----------------------------------------------------

function safeName(id) {
  // An owner id and a message id both come from this program, and a broken
  // client can still send another text. Only these characters reach the disk.
  return String(id).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
}

export function store(owner, messageId, record) {
  const folder = dir("queue", safeName(owner));
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${safeName(messageId)}.json`);
  // One write, or none. A relay that stops in the middle keeps no half file.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record));
  fs.renameSync(tmp, file);
  return file;
}

export function queued(owner) {
  const folder = dir("queue", safeName(owner));
  let files = [];
  try {
    files = fs.readdirSync(folder).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      out.push({ file: path.join(folder, f), ...JSON.parse(fs.readFileSync(path.join(folder, f), "utf8")) });
    } catch {
      // A file that no reader understands is of no use to anybody.
      fs.rmSync(path.join(folder, f), { force: true });
    }
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : 1));
}

export function drop(owner, messageId) {
  fs.rmSync(path.join(dir("queue", safeName(owner)), `${safeName(messageId)}.json`), { force: true });
}

// A message that waited too long, and a queue that grew too long, both stop
// here. The oldest message goes first.
export function sweep(owner, { now = Date.now() } = {}) {
  const rows = queued(owner);
  let removed = 0;
  for (const row of rows) {
    const old = now - Date.parse(row.at) > LIMITS.ageMs;
    const dead = row.expiresAt && Date.parse(row.expiresAt) <= now;
    if (old || dead) {
      fs.rmSync(row.file, { force: true });
      removed += 1;
    }
  }
  const left = queued(owner);
  for (const row of left.slice(0, Math.max(0, left.length - LIMITS.perOwner))) {
    fs.rmSync(row.file, { force: true });
    removed += 1;
  }
  return removed;
}

// A receipt for a sender that is offline waits here.
export function keepReceipt(owner, receipt) {
  const folder = dir("receipts", safeName(owner));
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `${safeName(receipt.messageId)}.json`), JSON.stringify(receipt));
}

export function receipts(owner) {
  const folder = dir("receipts", safeName(owner));
  try {
    return fs.readdirSync(folder).map((f) => ({
      file: path.join(folder, f),
      ...JSON.parse(fs.readFileSync(path.join(folder, f), "utf8")),
    }));
  } catch {
    return [];
  }
}

// --- the server ------------------------------------------------------------

export async function serve({ port = 0, host = "127.0.0.1", log = () => {} } = {}) {
  const server = http.createServer((req, res) => {
    res.writeHead(426, { "content-type": "text/plain" });
    res.end("openmsg relay: this address takes a WebSocket connection\n");
  });
  // One owner, one connection. A second connection of one owner replaces the
  // first, because a gateway that reconnects must not leave a dead reader.
  const owners = new Map();

  server.on("upgrade", (request, socket) => {
    if (!accepts(request)) {
      socket.destroy();
      return;
    }
    const connection = handshake(socket, request);
    let owner = null;

    const answer = (object) => connection.send(JSON.stringify(object));
    const stop = (text) => {
      answer({ type: "error", error: text });
      connection.close();
    };

    connection.on("message", (text) => {
      let frame;
      try {
        frame = JSON.parse(text);
      } catch {
        stop("the frame is not JSON");
        return;
      }
      if (!owner) {
        if (frame.type !== "hello") {
          stop("the first frame must be a hello");
          return;
        }
        const named = helloOwner(frame);
        if (!named) {
          stop("the hello does not prove that key");
          return;
        }
        owner = named;
        owners.get(owner)?.close();
        owners.set(owner, connection);
        sweep(owner);
        const waiting = queued(owner);
        answer({ type: "welcome", owner, waiting: waiting.length });
        log(`${owner} connected, ${waiting.length} waiting`);
        for (const row of waiting) answer({ type: "deliver", wire: row.wire, from: row.from });
        for (const row of receipts(owner)) {
          answer({ type: "receipt", messageId: row.messageId, status: row.status, reason: row.reason });
          fs.rmSync(row.file, { force: true });
        }
        return;
      }
      handle(frame, owner, answer, owners, log);
    });

    connection.on("close", () => {
      if (owner && owners.get(owner) === connection) {
        owners.delete(owner);
        log(`${owner} left`);
      }
    });
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const real = server.address().port;
  return {
    server,
    port: real,
    url: `ws://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${real}`,
    owners,
    close: () => new Promise((done) => server.close(done)),
  };
}

// The hello proves the key. The owner id comes from the two public keys, so a
// key that gives that owner id is the key of that owner. The relay needs no
// directory for this step.
function helloOwner(frame) {
  const { signature, ...body } = frame;
  if (!body.keys?.signing?.x || !body.keys?.encryption?.x) return null;
  if (body.owner !== ownerIdOf(body.keys)) return null;
  if (Math.abs(Date.now() - Date.parse(body.at ?? 0)) > LIMITS.helloWindowMs) return null;
  if (signature?.alg !== "Ed25519" || signature.by !== body.owner) return null;
  try {
    const ok = crypto.verify(
      null,
      canonicalBytes(body),
      publicKeyOf(body.keys.signing),
      Buffer.from(signature.value, "base64url"),
    );
    return ok ? body.owner : null;
  } catch {
    return null;
  }
}

// A connection that ended stays in the map until the socket says so. The
// relay therefore reads the answer of send(), and it forgets an owner whose
// connection does not take the text.
function push(owners, owner, frame) {
  const connection = owners.get(owner);
  if (!connection) return false;
  if (connection.send(JSON.stringify(frame))) return true;
  owners.delete(owner);
  return false;
}

function handle(frame, owner, answer, owners, log) {
  if (frame.type === "send") {
    const wire = frame.wire;
    const size = Buffer.byteLength(JSON.stringify(wire ?? {}));
    if (size > LIMITS.messageBytes) {
      answer({ type: "refused", messageId: wire?.messageId ?? null, reason: "too-big" });
      return;
    }
    const target = wire?.target?.owner;
    if (!target || !wire?.messageId) {
      answer({ type: "refused", messageId: wire?.messageId ?? null, reason: "bad-shape" });
      return;
    }
    // The relay cannot read the message, and it can compare the two owners
    // that the clear header names with the owner of this connection.
    if (wire?.from?.owner !== owner) {
      answer({ type: "refused", messageId: wire.messageId, reason: "sender-mismatch" });
      return;
    }
    if (wire.expiresAt && Date.parse(wire.expiresAt) <= Date.now()) {
      answer({ type: "refused", messageId: wire.messageId, reason: "expired" });
      return;
    }
    sweep(target);
    if (queued(target).length >= LIMITS.perOwner) {
      answer({ type: "refused", messageId: wire.messageId, reason: "queue-full" });
      return;
    }
    // The message is on the disk before the sender hears anything. A relay
    // that stops now still holds it.
    store(target, wire.messageId, { wire, from: owner, at: new Date().toISOString(), expiresAt: wire.expiresAt ?? null });
    answer({ type: "stored", messageId: wire.messageId });
    log(`${owner} → ${target} ${wire.messageId} (${size} bytes, sealed)`);
    // The message is on the disk. A push that fails now changes nothing,
    // because the receiver takes it on its next connection.
    push(owners, target, { type: "deliver", wire, from: owner });
    return;
  }

  if (frame.type === "ack") {
    // The receiver read the message. The relay keeps no copy after that.
    drop(owner, frame.messageId);
    const receipt = { type: "receipt", messageId: frame.messageId, status: frame.status, reason: frame.reason ?? null };
    // A sender that is offline gets the receipt on its next connection.
    if (frame.to && !push(owners, frame.to, receipt)) keepReceipt(frame.to, receipt);
    log(`${owner} acknowledged ${frame.messageId}: ${frame.status}`);
    return;
  }

  // A request for routing data, and its answer, travel between two gateways.
  // The relay forwards them, and it reads nothing but the two addresses.
  if (frame.type === "routing-request" || frame.type === "routing-answer") {
    if (!push(owners, frame.to, { ...frame, from: owner, to: undefined }) && frame.type === "routing-request") {
      answer({ type: "routing-answer", id: frame.id, from: frame.to, error: "that gateway is offline" });
    }
    return;
  }

  if (frame.type === "ping") {
    answer({ type: "pong" });
    return;
  }
  answer({ type: "error", error: `unknown frame "${frame.type}"` });
}
