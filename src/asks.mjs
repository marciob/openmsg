// The questions that an agent has for its owner, when the owner is not at the
// machine. A message from a chat of the owner approves work that can be
// undone, and nothing more. For the rest, the agent asks here, and the owner
// answers from another place, such as an app on a phone.
//
// This file is the store. A program that the owner chose reads the questions
// that wait, shows them to the owner, and runs `openmsg answer`.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";

// A question with no answer after this time gets none.
export const ASK_TTL_MS = 24 * 3600 * 1000;
export const MAX_QUESTION = 2000;
// A question with its answer stays this long, as the history of the owner.
export const HISTORY_MS = 30 * 24 * 3600 * 1000;

function file() {
  return path.join(process.env.OPENMSG_HOME ?? path.join(os.homedir(), ".openmsg"), "asks.json");
}

function read() {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8"));
  } catch {
    return [];
  }
}

function save(rows) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(rows, null, 1) + "\n", { mode: 0o600 });
}

export function put({ from, question, now = Date.now() }) {
  const text = String(question ?? "").trim();
  if (text === "") throw new Error("the question is empty");
  if (text.length > MAX_QUESTION) throw new Error(`the question is longer than ${MAX_QUESTION} characters`);
  const row = {
    id: randomBytes(4).toString("hex"),
    from: { vendor: from.vendor, id: from.id, name: from.name, cwd: from.cwd ?? null },
    question: text,
    askedAt: new Date(now).toISOString(),
    answer: null,
  };
  // Each row stays for 30 days, as a record. Older rows go.
  save([...read().filter((r) => now - Date.parse(r.askedAt) < HISTORY_MS), row]);
  return row;
}

export function all() {
  return read();
}

export function waiting({ now = Date.now() } = {}) {
  return read().filter((r) => r.answer === null && now - Date.parse(r.askedAt) < ASK_TTL_MS);
}

// The questions that have an answer, the newest first.
export function history({ limit = 40 } = {}) {
  return read()
    .filter((r) => r.answer !== null)
    .sort((a, b) => Date.parse(b.answeredAt) - Date.parse(a.answeredAt))
    .slice(0, limit);
}

// One question takes one answer. A second answer changes nothing, so an
// answer that arrives two times reaches the agent one time.
export function answer(id, yes, { via = "the command line", now = Date.now() } = {}) {
  const rows = read();
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`no question ${id}. Run: openmsg asks`);
  if (row.answer !== null) throw new Error(`the question ${id} has its answer already: ${row.answer}`);
  if (now - Date.parse(row.askedAt) >= ASK_TTL_MS) throw new Error(`the question ${id} is older than 24 hours`);
  row.answer = yes ? "yes" : "no";
  row.answeredAt = new Date(now).toISOString();
  row.via = via;
  save(rows);
  return row;
}
