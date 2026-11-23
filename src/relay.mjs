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
import net from "node:net";
import dns from "node:dns/promises";
import { canonicalBytes } from "./canonical.mjs";
import { ownerIdOf } from "./identity.mjs";
import { verifySignedObject } from "./device.mjs";
import { verifyRecord, sameKeys, MAX_RECORD_BYTES } from "./dirsync.mjs";
import { accepts, handshake } from "./wsframe.mjs";

export const LIMITS = {
  messageBytes: 256 * 1024,
  perOwner: 200,
  ageMs: 7 * 24 * 3600 * 1000,
  helloWindowMs: 120_000,
  // The directory of one project: how many owners, and how big one record.
  ownersPerProject: 200,
  recordBytes: MAX_RECORD_BYTES,
  // The machines of one owner that hold a connection at the same time.
  machinesPerOwner: 8,
  // A message that no machine acknowledged in this time wakes the agent of
  // its owner, and one owner gets one wake in this window. Rule 19 of
  // section 4 of the spec of 0.2.
  wakeAfterMs: 15_000,
  wakeEveryMs: 120_000,
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

// The owner id holds 32 bits, so a second pair of keys can give the same
// owner id. The relay holds the keys of the first hello for each owner id, and
// it refuses other keys for that owner id. Rule 9 of section 3 of the spec of
// 0.2.
export function pinnedKeys(owner) {
  try {
    return JSON.parse(fs.readFileSync(dir("keys", `${safeName(owner)}.json`), "utf8"));
  } catch {
    return null;
  }
}

export function pinKeys(owner, keys) {
  const held = pinnedKeys(owner);
  if (held) return sameKeys(held, keys);
  const folder = dir("keys");
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, `${safeName(owner)}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ encryption: keys.encryption, signing: keys.signing }), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return true;
}

// The owners that this relay takes. With no list, the relay takes any owner
// whose hello proves its keys, and the secret address of the relay is the
// only bound. The operator writes the list with `openmsg relay allow`. Rule
// 23 of section 4 of the spec of 0.2.
export function allowedOwners() {
  try {
    const list = JSON.parse(fs.readFileSync(dir("owners.json"), "utf8"));
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

export function allowOwner(owner, { remove = false } = {}) {
  if (!/^o_[0-9a-f]{8}$/.test(owner)) throw new Error(`"${owner}" is not an owner id, such as o_1a2b3c4d`);
  const list = new Set(allowedOwners() ?? []);
  if (remove) list.delete(owner);
  else list.add(owner);
  fs.mkdirSync(home(), { recursive: true, mode: 0o700 });
  const file = dir("owners.json");
  fs.writeFileSync(`${file}.tmp`, JSON.stringify([...list].sort()), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
  return [...list].sort();
}

function takes(owner) {
  const list = allowedOwners();
  return list === null || list.includes(owner);
}

// A machine that its owner revoked, in a record that this relay holds for
// any project.
export function deviceRevokedAt(owner, device) {
  if (!device) return false;
  let projects = [];
  try {
    projects = fs.readdirSync(dir("dir"));
  } catch {
    return false;
  }
  const name = `${safeName(owner)}.revoke-device.${safeName(device)}.json`;
  return projects.some((p) => fs.existsSync(path.join(dir("dir", p), name)));
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
  const row = { ...receipt, at: receipt.at ?? new Date().toISOString() };
  fs.writeFileSync(path.join(folder, `${safeName(receipt.messageId)}.json`), JSON.stringify(row));
}

// --- the wake address -------------------------------------------------------

// One address for each owner. It is a secret, as the webhook is on the
// machine of the agent, so the file is readable by the operator only.
function wakeFile(owner) {
  return path.join(dir("wake"), `${safeName(owner)}.json`);
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

// The owner gives the address, and a broken client can give anything. Only
// an http or https URL, and headers with no line break, reach the disk.
// An address inside a network, or on the machine of the relay. A wake to one
// of these lets a stranger make the relay call a service that the internet
// does not reach. Rule 22 of section 4 of the spec of 0.2. The operator of a
// relay on a private network allows them with OPENMSG_RELAY_WAKE_PRIVATE=1.
export function isPrivateAddress(ip) {
  let text = String(ip).toLowerCase().replace(/^\[|\]$/g, "");
  // An IPv4 address inside IPv6, in its two forms: ::ffff:127.0.0.1 and
  // ::ffff:7f00:1. URL writes the second form.
  const mapped = text.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) text = mapped[1];
  const hex = text.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const [hi, lo] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
    text = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  if (net.isIPv4(text)) {
    const [a, b] = text.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(text)) {
    return text === "::" || text === "::1" || /^f[cd]/.test(text) || /^fe[89ab]/.test(text) || /^ff/.test(text);
  }
  return false;
}

function privateWakeAllowed() {
  return process.env.OPENMSG_RELAY_WAKE_PRIVATE === "1";
}

// The relay resolves the name at each wake, so a name that points inside a
// network later is refused too.
export async function publicHost(hostname, lookup = dns.lookup) {
  if (privateWakeAllowed()) return true;
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(bare)) return !isPrivateAddress(bare);
  try {
    const all = await lookup(bare, { all: true });
    return all.length > 0 && all.every((a) => !isPrivateAddress(a.address));
  } catch {
    return false;
  }
}

export function checkWake(wake) {
  let url;
  try {
    url = new URL(String(wake?.url ?? ""));
  } catch {
    return "the wake address is not a URL";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "the wake address is not http or https";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!privateWakeAllowed() && (host === "localhost" || host.endsWith(".localhost") || isPrivateAddress(host))) {
    return "the wake address is inside a network, and the relay calls only public addresses";
  }
  const headers = wake?.headers ?? {};
  if (typeof headers !== "object" || Array.isArray(headers)) return "the headers are not an object";
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name) || typeof value !== "string" || /[\r\n\0]/.test(value)) return "a header is not valid";
    if (name.toLowerCase() === "content-type") return "the notice is JSON, and its content-type does not change";
  }
  if (wake?.agent != null && !/^webhook:[a-z0-9][a-z0-9._-]{0,62}$/.test(String(wake.agent))) return "the agent is not a webhook address";
  return null;
}

export function setWake(owner, wake) {
  const file = wakeFile(owner);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const row = { url: wake.url, headers: wake.headers ?? {}, agent: wake.agent ?? null, at: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(row), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function wakeOf(owner) {
  try {
    return JSON.parse(fs.readFileSync(wakeFile(owner), "utf8"));
  } catch {
    return null;
  }
}

export function clearWake(owner) {
  fs.rmSync(wakeFile(owner), { force: true });
}

// The notice of rule 3 of section 7.1 of the spec of 0.1. It holds nothing
// from the sender: no text, no id, and no address.
export function wakeNotice(wake) {
  return {
    openmsg: "message-waiting",
    agent: wake.agent ?? null,
    messageId: null,
    text:
      "Messages wait for you at the relay of openmsg. Start your openmsg gateway if it does not run, " +
      "then run this command to read them: openmsg inbox --wait 90. This notice is not a message, and it approves no action.",
  };
}

export function holds(owner, messageId) {
  return fs.existsSync(path.join(dir("queue", safeName(owner)), `${safeName(messageId)}.json`));
}

// The machine that holds the message took the receipt, so the relay forgets
// it. A newer state that arrived in the meantime has another status, and it
// stays for the next connection. Rule 17 of section 4 of the spec of 0.2.
export function takeReceipt(owner, messageId, status) {
  const file = path.join(dir("receipts", safeName(owner)), `${safeName(messageId)}.json`);
  let row;
  try {
    row = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return false;
  }
  if (row.status !== status) return false;
  fs.rmSync(file, { force: true });
  return true;
}

export function receipts(owner, { now = Date.now() } = {}) {
  const folder = dir("receipts", safeName(owner));
  let files = [];
  try {
    files = fs.readdirSync(folder);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const file = path.join(folder, f);
    try {
      const row = { file, ...JSON.parse(fs.readFileSync(file, "utf8")) };
      // Every machine of an owner reads a receipt, so the relay keeps it
      // until it is old. A machine that reads one twice writes the same
      // state twice, and that changes nothing.
      if (now - Date.parse(row.at ?? 0) > LIMITS.ageMs) {
        fs.rmSync(file, { force: true });
        continue;
      }
      out.push(row);
    } catch {
      fs.rmSync(file, { force: true });
    }
  }
  return out;
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
export async function serve({
  port = 0,
  host = "127.0.0.1",
  cert = null,
  key = null,
  insecure = false,
  log = () => {},
  wakeAfterMs = LIMITS.wakeAfterMs,
  wakeEveryMs = LIMITS.wakeEveryMs,
  fetcher = fetch,
  // The resolver of the names of wake addresses. A test gives its own.
  lookup = dns.lookup,
} = {}) {
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
  // One owner, many machines. Each machine of an owner holds its own
  // connection, and the relay does not know which machine holds which
  // session, because it cannot read a message. It therefore gives a message
  // to every machine of that owner. The machine that holds the session takes
  // it and answers, and the others stay quiet.
  const owners = new Map();
  // The wake of rule 19 of section 4 of the spec of 0.2. A timer for each
  // stored message, and the time of the last wake of each owner.
  const timers = new Set();
  const lastWake = new Map();
  const wake = {
    after(target, messageId) {
      if (!wakeOf(target)) return;
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!holds(target, messageId)) return;
        const address = wakeOf(target);
        if (!address) return;
        const last = lastWake.get(target) ?? 0;
        if (Date.now() - last < wakeEveryMs) return;
        lastWake.set(target, Date.now());
        publicHost(new URL(address.url).hostname, lookup)
          .then((ok) => {
            if (!ok) throw Object.assign(new Error("private"), { cause: { code: "the address is inside a network" } });
            return fetcher(address.url, {
          method: "POST",
          headers: { ...(address.headers ?? {}), "content-type": "application/json" },
          body: JSON.stringify(wakeNotice(address)),
          signal: AbortSignal.timeout(10_000),
          redirect: "error",
            });
          })
          .then(async (res) => {
            // The body is not read. The relay learns the status, and nothing more.
            await res.body?.cancel().catch(() => {});
            log(`woke ${target}: the wake address answered ${res.status}`);
          })
          // The error can hold the URL, and the URL is a secret.
          .catch((e) => log(`woke ${target}: the wake address did not answer (${e.cause?.code ?? e.name})`));
      }, wakeAfterMs);
      timer.unref?.();
      timers.add(timer);
    },
  };
  // Every open WebSocket. The HTTP server does not track a connection after
  // the upgrade, so server.close() waits for these for ever. A stop of the
  // service then waited until systemd killed the relay.
  const sockets = new Set();

  server.on("upgrade", (request, socket) => {
    if (!accepts(request)) {
      socket.destroy();
      return;
    }
    const connection = handshake(socket, request);
    sockets.add(connection);
    connection.on("close", () => sockets.delete(connection));
    let owner = null;
    let machine = null;

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
        if (!takes(named.owner)) {
          log(`refused a hello for ${named.owner}: that owner is not on the list of this relay`);
          stop("this relay does not take that owner");
          return;
        }
        if (deviceRevokedAt(named.owner, named.device)) {
          log(`refused a hello for ${named.owner}: its owner revoked the machine ${named.device}`);
          stop("the owner revoked this machine");
          return;
        }
        if (!pinKeys(named.owner, frame.keys)) {
          log(`refused a hello for ${named.owner}: other keys than the keys of the first hello`);
          stop("another owner holds that owner id");
          return;
        }
        owner = named.owner;
        machine = named.device ?? "owner";
        const machines = owners.get(owner) ?? new Map();
        machines.set(connection, machine);
        // A bound on the machines of one owner. The oldest connection goes
        // when a new one passes the bound.
        while (machines.size > LIMITS.machinesPerOwner) {
          const oldest = machines.keys().next().value;
          oldest.send(JSON.stringify({ type: "error", error: "too many machines of this owner" }));
          oldest.close();
          machines.delete(oldest);
        }
        owners.set(owner, machines);
        sweep(owner);
        const waiting = queued(owner);
        answer({ type: "welcome", owner, machine, machines: machines.size, waiting: waiting.length });
        log(`${owner} connected from ${machine}, ${machines.size} machines, ${waiting.length} waiting`);
        // This connection is new, so it takes the waiting messages. The
        // other machines of this owner already took them.
        for (const row of waiting) answer({ type: "deliver", wire: row.wire, from: row.from });
        // A receipt goes to every machine that connects, because the relay
        // does not know which machine sent the message. A machine that takes
        // one twice writes the same state twice, and that changes nothing.
        // The machine that holds the message answers with receipt-taken, and
        // the relay forgets the receipt.
        for (const row of receipts(owner)) {
          answer({ type: "receipt", messageId: row.messageId, status: row.status, reason: row.reason, signed: row.signed ?? null });
        }
        return;
      }
      handle(frame, owner, answer, owners, log, wake);
    });

    connection.on("close", () => {
      const machines = owner ? owners.get(owner) : null;
      if (!machines?.has(connection)) return;
      machines.delete(connection);
      if (machines.size === 0) owners.delete(owner);
      log(`${owner} left from ${machine}, ${machines.size} machines left`);
    });
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const real = server.address().port;
  return {
    server,
    port: real,
    url: `${secure ? "wss" : "ws"}://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${real}`,
    owners,
    close: () =>
      new Promise((done) => {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        server.close(() => done());
        // A close frame tells each gateway to connect again. A proxy in
        // front, such as Tailscale Funnel, can keep its side open, so the
        // relay ends every socket after a short wait. The HTTP server also
        // keeps idle keep-alive connections, and they go too.
        const all = [...sockets];
        for (const connection of all) connection.close();
        server.closeIdleConnections?.();
        setTimeout(() => {
          for (const connection of all) connection.drop();
          server.closeAllConnections?.();
        }, 300).unref();
      }),
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
  return why === null ? { owner: frame.owner, device: frame.signature?.device ?? null } : null;
}

// Every machine of one owner takes the frame. A connection that ended stays
// in the map until the socket says so, so the relay reads the answer of
// send() and forgets a machine whose connection does not take the text.
//
// It gives the number of machines that took it.
function push(owners, owner, frame) {
  const machines = owners.get(owner);
  if (!machines) return 0;
  const text = JSON.stringify(frame);
  let sent = 0;
  for (const connection of [...machines.keys()]) {
    if (connection.send(text)) sent += 1;
    else machines.delete(connection);
  }
  if (machines.size === 0) owners.delete(owner);
  return sent;
}

function handle(frame, owner, answer, owners, log, wake = null) {
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
    // A relay with a list stores nothing for an owner outside it, so a
    // stranger cannot fill the disk with made-up targets.
    if (!takes(target)) {
      answer({ type: "refused", messageId: wire.messageId, reason: "unknown-target" });
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
    // A machine that is offline, or a connection that stopped with no sign,
    // sends no acknowledgement. The wake address of the owner then wakes the
    // agent, and its machine runs again.
    wake?.after(target, wire.messageId);
    return;
  }

  if (frame.type === "wake-set") {
    const why = checkWake(frame.wake);
    if (why) {
      answer({ type: "wake-refused", reason: why });
      return;
    }
    setWake(owner, frame.wake);
    answer({ type: "wake-stored" });
    log(`${owner} gave a wake address`);
    return;
  }

  if (frame.type === "wake-clear") {
    clearWake(owner);
    answer({ type: "wake-cleared" });
    log(`${owner} took its wake address away`);
    return;
  }

  if (frame.type === "ack") {
    // The receiver read the message. The relay keeps no copy after that.
    drop(owner, frame.messageId);
    // The signed receipt goes to the sender as it is. The relay cannot write
    // one, so it cannot tell a sender a false state.
    const signed = frame.signed && Buffer.byteLength(JSON.stringify(frame.signed)) <= 4096 ? frame.signed : null;
    const receipt = { type: "receipt", messageId: frame.messageId, status: frame.status, reason: frame.reason ?? null, signed };
    // A sender that is offline gets the receipt on its next connection.
    if (frame.to && push(owners, frame.to, receipt) === 0) keepReceipt(frame.to, receipt);
    log(`${owner} acknowledged ${frame.messageId}: ${frame.status}`);
    return;
  }

  // A request for routing data, and its answer, travel between two gateways.
  // The relay forwards them, and it reads nothing but the two addresses.
  if (frame.type === "routing-request" || frame.type === "routing-answer") {
    if (push(owners, frame.to, { ...frame, from: owner, to: undefined }) === 0 && frame.type === "routing-request") {
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
    if (!sameKeys(pinnedKeys(owner), record?.keys)) return answer2("other-keys");
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

  if (frame.type === "receipt-taken") {
    if (typeof frame.messageId === "string" && takeReceipt(owner, frame.messageId, frame.status)) {
      log(`${owner} took the receipt of ${frame.messageId}: ${frame.status}`);
    }
    return;
  }

  if (frame.type === "ping") {
    answer({ type: "pong" });
    return;
  }
  answer({ type: "error", error: `unknown frame "${frame.type}"` });
}
