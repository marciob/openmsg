// The questions that an agent has for its owner, when the owner is not at the
// machine. A message from a chat of the owner approves work that can be
// undone, and nothing more. For the rest, the agent asks here, and the owner
// answers from another place, such as a phone app, an email, or a chat.
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
// A review shows images, such as a screenshot of a page, and options. The
// owner answers with one option, a comment, or both.
export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_OPTIONS = 6;
export const MAX_OPTION = 80;
export const MAX_COMMENT = 2000;
const IMAGE_TYPES = { ".png": "png", ".jpg": "jpg", ".jpeg": "jpg" };

function home() {
  return process.env.OPENMSG_HOME ?? path.join(os.homedir(), ".openmsg");
}

function file() {
  return path.join(home(), "asks.json");
}

// The copies of the images of a review. A copy stays while the question
// waits, so the agent can change or delete its own file.
export function filesDir() {
  return path.join(home(), "ask-files");
}

function dropFiles(row) {
  for (const name of row.images ?? []) fs.rmSync(path.join(filesDir(), name), { force: true });
}

function checkImages(list) {
  const images = (list ?? []).map((p) => path.resolve(String(p)));
  if (images.length > MAX_IMAGES) throw new Error(`a question takes ${MAX_IMAGES} images or fewer`);
  for (const p of images) {
    const type = IMAGE_TYPES[path.extname(p).toLowerCase()];
    if (!type) throw new Error(`${p} is not a PNG or JPEG file. For a page, send a screenshot of it`);
    let size;
    try { size = fs.statSync(p).size; } catch { throw new Error(`no file ${p}`); }
    if (size > MAX_IMAGE_BYTES) throw new Error(`${p} is larger than 8 MB`);
  }
  return images;
}

function checkOptions(list) {
  const options = (list ?? []).map((o) => String(o).trim());
  if (options.length > MAX_OPTIONS) throw new Error(`a question takes ${MAX_OPTIONS} options or fewer`);
  if (options.length === 1) throw new Error("give two options or more, or none");
  for (const o of options) {
    if (o === "") throw new Error("an option is empty");
    if (o.length > MAX_OPTION) throw new Error(`the option "${o.slice(0, 20)}…" is longer than ${MAX_OPTION} characters`);
  }
  if (new Set(options).size !== options.length) throw new Error("two options have the same text");
  return options;
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

// With images or options, the question is a review: the owner gives an
// option, a comment, or both, and not yes or no.
export function put({ from, question, images, options, now = Date.now() }) {
  const text = String(question ?? "").trim();
  if (text === "") throw new Error("the question is empty");
  if (text.length > MAX_QUESTION) throw new Error(`the question is longer than ${MAX_QUESTION} characters`);
  const sources = checkImages(images);
  const choices = checkOptions(options);
  const id = randomBytes(4).toString("hex");
  const row = {
    id,
    kind: sources.length > 0 || choices.length > 0 ? "review" : "approval",
    from: { vendor: from.vendor, id: from.id, name: from.name, cwd: from.cwd ?? null },
    question: text,
    askedAt: new Date(now).toISOString(),
    answer: null,
  };
  if (row.kind === "review") {
    fs.mkdirSync(filesDir(), { recursive: true, mode: 0o700 });
    row.images = sources.map((p, i) => {
      const name = `${id}-${i + 1}.${IMAGE_TYPES[path.extname(p).toLowerCase()]}`;
      fs.copyFileSync(p, path.join(filesDir(), name));
      return name;
    });
    row.options = choices;
  }
  // Each row stays for 30 days, as a record. Older rows go. The images of a
  // question that waits no more go too.
  const kept = [];
  for (const r of read()) {
    if (now - Date.parse(r.askedAt) < HISTORY_MS) kept.push(r);
    if (r.answer !== null || now - Date.parse(r.askedAt) >= ASK_TTL_MS) dropFiles(r);
  }
  save([...kept, row]);
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
function open(rows, id, now) {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`no question ${id}. Run: openmsg asks`);
  if (row.answer !== null) throw new Error(`the question ${id} has its answer already: ${row.answer}`);
  if (now - Date.parse(row.askedAt) >= ASK_TTL_MS) throw new Error(`the question ${id} is older than 24 hours`);
  return row;
}

export function answer(id, yes, { via = "the command line", now = Date.now() } = {}) {
  const rows = read();
  const row = open(rows, id, now);
  if (row.kind === "review") throw new Error(`the question ${id} is a review. Answer with --choice, --comment, or both`);
  row.answer = yes ? "yes" : "no";
  row.answeredAt = new Date(now).toISOString();
  row.via = via;
  save(rows);
  return row;
}

// The answer to a review: one option, a comment, or both. An option is its
// text or its number, from 1.
export function review(id, { choice, comment } = {}, { via = "the command line", now = Date.now() } = {}) {
  const rows = read();
  const row = open(rows, id, now);
  if (row.kind !== "review") throw new Error(`the question ${id} takes yes or no`);
  const note = String(comment ?? "").trim();
  if (note.length > MAX_COMMENT) throw new Error(`the comment is longer than ${MAX_COMMENT} characters`);
  let picked = null;
  if (choice !== undefined && choice !== null && String(choice).trim() !== "") {
    const c = String(choice).trim();
    const options = row.options ?? [];
    picked = options.includes(c) ? c : /^[1-9]$/.test(c) && options[Number(c) - 1] ? options[Number(c) - 1] : null;
    if (picked === null) throw new Error(`no option "${c}". The options: ${options.join(" | ") || "none"}`);
  }
  if (picked === null && note === "") throw new Error("give an option, a comment, or both");
  row.answer = "feedback";
  row.choice = picked;
  row.comment = note === "" ? null : note;
  row.answeredAt = new Date(now).toISOString();
  row.via = via;
  save(rows);
  dropFiles(row);
  return row;
}
