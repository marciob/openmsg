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

// The states of a delivery, in their order. Receipts can arrive out of
// order: a receipt that the relay kept can be older than a live one. The
// state goes forward, never back. A state outside this list, such as
// "refused" or "held", is always written.
const ORDER = ["sent", "queued", "adapter-accepted", "agent-acknowledged", "replied"];

export function behind(current, next) {
  return ORDER.includes(current) && ORDER.includes(next) && ORDER.indexOf(next) < ORDER.indexOf(current);
}

// The state that a receipt gives. It returns the row, or null when this
// machine holds no copy. It writes nothing for a state that is behind, or
// for the state that the row already has.
export function advance(messageId, state, extra = {}) {
  const row = find(messageId);
  if (!row) return null;
  const same = row.state === state && (row.reason ?? null) === (extra.reason ?? null);
  if (same || behind(row.state, state)) return { ...row, written: false };
  return { ...put({ ...row, state, ...extra }), written: true };
}

// A message that waits for a receipt. The gateway sends these again when it
// reaches the relay.
export function waiting() {
  return list().filter((r) => r.state === "sent" || r.state === "queued");
}

// A message that reached the adapter of the other side, and that no agent
// read in this time. The adapter takes a message at once, so a wait this long
// means that the agent did not run: it is busy, or the account that pays for
// it has no credits. It does not mean that the agent is offline.
export const SILENT_MS = 5 * 60 * 1000;
const SILENT_WINDOW_MS = 24 * 3600 * 1000;

export function silent({ now = Date.now(), afterMs = SILENT_MS, alias = null } = {}) {
  return list().filter((r) => {
    if (r.state !== "adapter-accepted") return false;
    if (alias && r.alias !== alias) return false;
    const age = now - Date.parse(r.at);
    return age >= afterMs && age < SILENT_WINDOW_MS;
  });
}

export function silenceNote(row, { now = Date.now() } = {}) {
  const minutes = Math.floor((now - Date.parse(row.at)) / 60000);
  return (
    `${row.messageId.slice(0, 8)} to ${row.alias ?? row.to} reached the agent ${minutes} min ago, and no agent said that it read it. ` +
    "The agent can be busy, or out of credits. A new message wakes it again, and an agent that runs on credits pays for each wake."
  );
}
