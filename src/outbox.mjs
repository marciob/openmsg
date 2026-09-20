// The copy of the sender. A message stays here until a receipt says that the
// other side holds it. The relay keeps its own copy, and the two copies mean
// that one loss on one side loses nothing.
import fs from "node:fs";
import path from "node:path";
import { home } from "./identity.mjs";

function file() {
  return path.join(home(), "outbox.jsonl");
}

export function put(record) {
  const target = file();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const row = { ...record, at: new Date().toISOString() };
  fs.appendFileSync(target, JSON.stringify(row) + "\n");
  return row;
}

export function list({ state = null } = {}) {
  let rows = [];
  try {
    rows = fs.readFileSync(file(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
  const latest = new Map();
  for (const row of rows) latest.set(row.messageId, { ...(latest.get(row.messageId) ?? {}), ...row });
  const out = [...latest.values()];
  return state ? out.filter((r) => r.state === state) : out;
}

export function find(messageId) {
  return list().find((r) => r.messageId === messageId) ?? null;
}

export function setState(messageId, state, extra = {}) {
  const row = find(messageId);
  if (!row) return null;
  return put({ ...row, state, ...extra });
}

// A message that waits for a receipt. The gateway sends these again when it
// reaches the relay.
export function waiting() {
  return list().filter((r) => r.state === "sent" || r.state === "queued");
}
