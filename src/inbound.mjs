// The durable store of every message that arrived from another person.
//
// The receiver writes the message here before it gives the message to an
// agent. A crash after the write therefore leaves a record, and the owner sees
// the state that the message reached.
import fs from "node:fs";
import path from "node:path";
import { home } from "./identity.mjs";

function file() {
  return path.join(home(), "inbound.jsonl");
}

export function put(record) {
  const target = file();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const row = { ...record, at: record.at ?? new Date().toISOString() };
  fs.appendFileSync(target, JSON.stringify(row) + "\n");
  return row;
}

export function list({ status = null } = {}) {
  let rows = [];
  try {
    rows = fs.readFileSync(file(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
  // A later row for one message id replaces an earlier row. The file keeps the
  // whole history, and the reader sees the state of now.
  const latest = new Map();
  for (const row of rows) latest.set(row.messageId, { ...(latest.get(row.messageId) ?? {}), ...row });
  const out = [...latest.values()];
  return status ? out.filter((r) => r.status === status) : out;
}

export function find(messageId) {
  return list().find((r) => r.messageId === messageId) ?? null;
}

// A short id is enough for a person to name a held message.
export function findByPrefix(prefix) {
  const matches = list().filter((r) => r.messageId.startsWith(prefix));
  if (matches.length > 1) throw new Error(`"${prefix}" names ${matches.length} messages. Use more characters.`);
  return matches[0] ?? null;
}

export function setStatus(messageId, status, extra = {}) {
  const row = find(messageId);
  if (!row) throw new Error(`no message ${messageId} in the store`);
  return put({ ...row, status, ...extra, at: new Date().toISOString() });
}
