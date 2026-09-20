// The mailbox keeps every message on disk. It has two jobs:
// 1. A record of what openmsg sent and received.
// 2. A place to read from for agents that cannot receive a push, such as
//    Gemini CLI and Cursor CLI. Their hooks read the mailbox at the end of a turn.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { address } from "./envelope.mjs";

const ROOT = process.env.OPENMSG_HOME ?? path.join(os.homedir(), ".openmsg");

// The file name encodes the address. encodeURIComponent keeps the name unique,
// because two different addresses never give the same name, and it removes the
// characters that Windows refuses, such as the colon.
function encodeName(addr) {
  // encodeURIComponent keeps six characters that Windows refuses or treats in a
  // special way. A name that ends with a dot is also illegal on Windows.
  return encodeURIComponent(addr)
    .replace(/[!'()*~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/\.$/, "%2E");
}

function boxPath(agent) {
  return path.join(ROOT, "inbox", `${encodeName(address(agent))}.jsonl`);
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

export function markRead(agent) {
  const file = boxPath(agent);
  if (!fs.existsSync(file)) return 0;
  const rows = list(agent);
  const unread = rows.filter((r) => r.status !== "read").length;
  fs.writeFileSync(file, rows.map((r) => JSON.stringify({ ...r, status: "read" }) + "\n").join(""));
  return unread;
}

// A reply needs the message that it answers. The sender wrote that message into
// the mailbox of the receiver, so the receiver finds it in its own mailbox.
export function find(agent, messageId) {
  return list(agent, { unreadOnly: false }).find((m) => m.messageId === messageId) ?? null;
}
