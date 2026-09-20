// The durable store of every message that arrived from another person.
//
// The receiver writes the message here before it gives the message to an
// agent. A crash after the write therefore leaves a record, and the owner sees
// the state that the message reached.
import fs from "node:fs";
import path from "node:path";
import { home } from "./identity.mjs";

// The seven states of section 8 of the spec. A message holds one of them.
//
// `adapter-accepted` says that the adapter of the vendor took the message.
// Whether the model read it is another question, and `agent-acknowledged`
// answers that one. Only an event from the agent gives that state.
export const STATES = [
  "queued",
  "held",
  "adapter-accepted",
  "agent-acknowledged",
  "replied",
  "refused",
  "expired",
];

function file() {
  return path.join(home(), "inbound.jsonl");
}

// What each state says, in one sentence. A person reads these words, and case
// 14 of the acceptance demonstration needs them: after a crash between the
// injection and the acknowledgement, the receiver must say that it does not
// know whether the model read the message.
export const EXPLAIN = {
  queued:
    "it waits: the sender holds it, or the receiver holds it before the adapter takes it. " +
    "After a stop here, nobody knows whether the adapter took it",
  held: "it waits for the owner, and no model read it",
  "adapter-accepted": "the adapter took it, and whether the model read it is unknown",
  "agent-acknowledged": "the agent said that it read it",
  replied: "the agent answered it",
  refused: "a rule stopped it",
  expired: "the deadline passed",
};

export function put(record) {
  if (record.status && !STATES.includes(record.status)) {
    throw new Error(`"${record.status}" is not a state of a message. The states are: ${STATES.join(", ")}`);
  }
  const target = file();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const now = new Date().toISOString();
  // `receivedAt` is the arrival, and `at` is the last change of the state. A
  // rate limit counts arrivals, so the two are not the same field.
  const row = { ...record, receivedAt: record.receivedAt ?? now, at: now };
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
