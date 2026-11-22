// The mailbox keeps every message on disk. It has two jobs:
// 1. A record of what openmsg sent and received.
// 2. A place to read from for agents that cannot receive a push, such as
//    Gemini CLI and Cursor CLI. Their hooks read the mailbox at the end of a turn.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { address } from "./envelope.mjs";

// The home reads from the environment at each call, so one process can hold
// the mailbox of one person and the mailbox of another.
function root() {
  return process.env.OPENMSG_HOME ?? path.join(os.homedir(), ".openmsg");
}

// The file name encodes the address. encodeURIComponent keeps the name unique,
// because two different addresses never give the same name, and it removes the
// characters that Windows refuses, such as the colon.
export function encodeName(addr) {
  // encodeURIComponent keeps six characters that Windows refuses or treats in a
  // special way. A name that ends with a dot is also illegal on Windows.
  return encodeURIComponent(addr)
    .replace(/[!'()*~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/\.$/, "%2E");
}

function boxPath(agent) {
  return path.join(root(), "inbox", `${encodeName(address(agent))}.jsonl`);
}

export function addressOfFile(file) {
  return decodeURIComponent(path.basename(file, ".jsonl"));
}

export function put(agent, message, status) {
  const file = boxPath(agent);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ ...message, status }) + "\n");
  return file;
}

export function list(agent, { unreadOnly = false } = {}) {
  const file = boxPath(agent);
  if (!fs.existsSync(file)) return [];
  const rows = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return unreadOnly ? rows.filter((r) => r.status !== "read") : rows;
}

// markRead takes the ids that the agent saw. A message that the reader refused
// keeps its state, so the next read reports it again.
export function markRead(agent, messageIds) {
  const file = boxPath(agent);
  if (!fs.existsSync(file)) return 0;
  const seen = new Set(messageIds);
  const rows = list(agent);
  let count = 0;
  const next = rows.map((r) => {
    if (!seen.has(r.messageId) || r.status === "read") return r;
    count += 1;
    return { ...r, status: "read" };
  });
  fs.writeFileSync(file, next.map((r) => JSON.stringify(r) + "\n").join(""));
  return count;
}

// A reply needs the message that it answers. The sender wrote that message into
// the mailbox of the receiver, so the receiver finds it in its own mailbox.
// The text for the model gives a short id, so a prefix is enough.
export function find(agent, messageId) {
  const rows = list(agent, { unreadOnly: false });
  const exact = rows.find((m) => m.messageId === messageId);
  if (exact) return exact;
  const matches = rows.filter((m) => m.messageId.startsWith(messageId));
  if (matches.length > 1) throw new Error(`"${messageId}" names ${matches.length} messages. Use more characters.`);
  return matches[0] ?? null;
}

// An agent that waits for a message in this turn. `openmsg inbox --wait`
// writes this file, and the adapter of a webhook agent then sends no notice:
// the agent reads the message in this turn, and a notice would start a
// second turn. Rule 8 of section 7.1 of the spec of 0.1.
function waitPath(agent) {
  return path.join(root(), "waiting", `${encodeName(address(agent))}.json`);
}

export function markWaiting(agent, untilMs, pid = process.pid) {
  const file = waitPath(agent);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid, until: new Date(untilMs).toISOString() }));
}

export function clearWaiting(agent, pid = process.pid) {
  const file = waitPath(agent);
  try {
    // Another wait of the same agent can own the file now.
    if (JSON.parse(fs.readFileSync(file, "utf8")).pid !== pid) return;
  } catch {
    return;
  }
  fs.rmSync(file, { force: true });
}

export function isWaiting(agent, { now = Date.now() } = {}) {
  let row;
  try {
    row = JSON.parse(fs.readFileSync(waitPath(agent), "utf8"));
  } catch {
    return false;
  }
  if (!(Date.parse(row.until) > now)) return false;
  try {
    process.kill(row.pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process runs under another user, and it runs.
    return e.code === "EPERM";
  }
}
