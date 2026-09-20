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
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { canonicalBytes } from "./canonical.mjs";
import { ownerIdOf } from "./identity.mjs";
import { verifySignedObject } from "./device.mjs";
import { verifyRecord, MAX_RECORD_BYTES } from "./dirsync.mjs";
import { accepts, handshake } from "./wsframe.mjs";

export const LIMITS = {
  messageBytes: 256 * 1024,
  perOwner: 200,
  ageMs: 7 * 24 * 3600 * 1000,
  helloWindowMs: 120_000,
  // The directory of one project: how many owners, and how big one record.
  ownersPerProject: 200,
  recordBytes: MAX_RECORD_BYTES,
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

// --- the directory of a project ---------------------------------------------
//
// The relay holds the records, and it reads no message. A record is signed by
// its owner, and the owner id comes from the keys inside it, so the relay
// verifies a record without a directory of its own.

// One record for one owner, one kind, and one thing. Two machines of one
// owner each keep their own roster, and two revoked machines each keep their
// own record. Without this, one write covers another.
export function recordKey(record) {
  const parts = [record.owner, record.kind];
  if (record.kind === "roster") parts.push(record.signature?.device ?? "owner");
  if (record.kind === "revoke-device") parts.push(record.device);
  return parts.map(safeName).join(".");
}

export function putRecord(project, record) {
  const folder = dir("dir", safeName(project));
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${recordKey(record)}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record));
  fs.renameSync(tmp, file);
  return file;
}

export function records(project) {
  const folder = dir("dir", safeName(project));
  let files = [];
  try {
    files = fs.readdirSync(folder).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(folder, f), "utf8")));
    } catch {
      fs.rmSync(path.join(folder, f), { force: true });
    }
  }
  return out;
}

// A reader of a project is an owner that already has a record there. A
// project with no record at all takes its first owner, because the project id
// is opaque and the owner that made it is the owner that publishes first.
function mayRead(project, owner) {
  const rows = records(project);
  return rows.length === 0 || rows.some((r) => r.owner === owner);
}

function ownersIn(project) {
  return new Set(records(project).map((r) => r.owner)).size;
}

// --- the server ------------------------------------------------------------

export const LOOPBACK = ["127.0.0.1", "localhost", "::1", "[::1]"];

export function isLoopback(host) {
  return LOOPBACK.includes(String(host));
}

// A relay that other machines reach speaks TLS. Section 4.2 of the spec asks
// for it, and a gateway sends its hello and the addresses of its messages
// over that connection. The body of a message is sealed, and the addresses
// are not.
//
// `cert` and `key` give TLS here. A relay behind a proxy that ends TLS takes
// `insecure`, and the operator types that word.
export async function serve({ port = 0, host = "127.0.0.1", cert = null, key = null, insecure = false, log = () => {} } = {}) {
  const answer = (req, res) => {
    res.writeHead(426, { "content-type": "text/plain" });
    res.end("openmsg relay: this address takes a WebSocket connection\n");
  };
  const secure = Boolean(cert && key);
  if (!secure && !isLoopback(host) && !insecure) {
    throw new Error(
      `a relay on ${host} carries the messages of other people, and this one has no TLS. ` +
        "Give --cert <file> and --key <file>, or put a proxy that ends TLS in front and add --insecure.",
    );
  }
  const server = secure
    ? https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, answer)
    : http.createServer(answer);
  if (!secure && !isLoopback(host)) {
    log("WARNING: this relay speaks no TLS. A proxy in front must end TLS, or the addresses travel in the open.");
  }
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
        // One owner, one connection. A second machine of that owner takes
        // the place of the first, and the first hears why. Two machines of
        // one owner online at the same time is open work.
        const before = owners.get(owner);
        if (before) {
          before.send(JSON.stringify({ type: "error", error: "another machine of this owner connected" }));
          before.close();
        }
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
    url: `${secure ? "wss" : "ws"}://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${real}`,
    owners,
    close: () => new Promise((done) => server.close(done)),
  };
}

// The hello proves the key. The owner id comes from the two public keys, so a
// key that gives that owner id is the key of that owner. The relay needs no
// directory for this step.
function helloOwner(frame) {
  const keys = frame?.keys;
  if (!keys?.signing?.x || !keys?.encryption?.x) return null;
  // The owner id comes from the keys, so these keys are the keys of that
  // owner, and of nobody else.
  if (frame.owner !== ownerIdOf(keys)) return null;
  if (Math.abs(Date.now() - Date.parse(frame.at ?? 0)) > LIMITS.helloWindowMs) return null;
  // A machine of that owner signs with its own key, and the delegation in
  // the hello proves that the owner allows it.
  const why = verifySignedObject(frame, { ownerId: frame.owner, keys });
  return why === null ? frame.owner : null;
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

  if (frame.type === "dir-publish") {
    const record = frame.record;
    const answer2 = (reason) => answer({ type: "dir-refused", kind: record?.kind ?? null, project: record?.project ?? null, reason });
    if (Buffer.byteLength(JSON.stringify(record ?? {})) > LIMITS.recordBytes) return answer2("too-big");
    // An owner publishes about itself, and about nobody else.
    if (record?.owner !== owner) return answer2("sender-mismatch");
    const why = verifyRecord(record);
    if (why) return answer2(why);
    if (!mayRead(record.project, owner) && ownersIn(record.project) >= LIMITS.ownersPerProject) {
      return answer2("project-full");
    }
    putRecord(record.project, record);
    answer({ type: "dir-stored", kind: record.kind, project: record.project });
    log(`${owner} published a ${record.kind} record for ${record.project}`);
    return;
  }

  if (frame.type === "dir-fetch") {
    if (!mayRead(frame.project, owner)) {
      answer({ type: "dir-records", id: frame.id, project: frame.project, records: [], error: "you have no record in that project" });
      return;
    }
    answer({ type: "dir-records", id: frame.id, project: frame.project, records: records(frame.project) });
    return;
  }

  if (frame.type === "ping") {
    answer({ type: "pong" });
    return;
  }
  answer({ type: "error", error: `unknown frame "${frame.type}"` });
}
