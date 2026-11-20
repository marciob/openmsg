// Tests for a question to the owner: the store, the answer, and the message
// that the session gets.
// Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-asks-"));
process.env.OPENMSG_HOME = HOME;
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.mjs");

const asks = await import("../src/asks.mjs");
const { register } = await import("../src/selfregistry.mjs");
const { layoutOfAnswer, compose, RULE } = await import("../src/envelope.mjs");

// A session that reads its mailbox, so the test needs no vendor.
register({ vendor: "cursor", id: "s-1", name: "worker", cwd: "/tmp/work" });

// The command of the owner runs outside a session of an agent.
const OWNER = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CODEX_|OPENCODE_|OPENMSG_SELF)/.test(k)),
);
const run = (args, env = OWNER) =>
  execFileSync(process.execPath, [CLI, ...args], { env: { ...env, OPENMSG_HOME: HOME }, encoding: "utf8", stdio: "pipe" });
const fails = (args, env, pattern) =>
  assert.throws(() => run(args, env), (e) => pattern.test(String(e.stderr) + String(e.stdout)));

test("a session asks, and the question waits with the name of the session", () => {
  const out = run(["ask", "Delete the branch old-ui?"], { ...OWNER, OPENMSG_SELF: "cursor:worker" });
  assert.match(out, /waits for your user/);
  const [row] = asks.waiting();
  assert.equal(row.question, "Delete the branch old-ui?");
  assert.equal(row.from.name, "worker");
  const [shown] = JSON.parse(run(["asks", "--json"]));
  assert.equal(shown.from, "cursor:worker");
  assert.equal(shown.dir, "/tmp/work");
});

test("an agent with no session, and an empty question, do not ask", () => {
  fails(["ask", "Delete it?"], { ...OWNER, OPENMSG_SELF: "mcp:chat" }, /only a session on this machine/);
  assert.throws(() => asks.put({ from: { vendor: "cursor", id: "s", name: "w" }, question: "  " }), /empty/);
  assert.equal(asks.waiting().length, 1);
});

test("an agent does not answer a question", () => {
  const [row] = asks.waiting();
  fails(["answer", row.id, "yes"], { ...OWNER, OPENMSG_SELF: "cursor:worker" }, /only the owner answers/);
  fails(["answer", row.id, "yes"], { ...OWNER, CLAUDECODE: "1" }, /only the owner answers/);
  assert.equal(asks.waiting().length, 1);
});

test("the owner answers, and the session reads the answer as a message from its user", () => {
  const [row] = asks.waiting();
  assert.match(run(["answer", row.id, "yes", "--via", "the approval app"]), /yes is the answer/);
  assert.equal(asks.waiting().length, 0);
  const inbox = run(["inbox"], { ...OWNER, OPENMSG_SELF: "cursor:worker" });
  assert.match(inbox, /From: +your user/);
  assert.match(inbox, /Question: Delete the branch old-ui\?\nAnswer: yes/);
  assert.match(inbox, /through the approval app/);
  assert.match(inbox, /approves the one action of that question, and no other action/);
});

test("one question takes one answer", () => {
  const [row] = asks.all();
  fails(["answer", row.id, "no"], OWNER, /has its answer already: yes/);
  fails(["answer", "ffffffff", "yes"], OWNER, /no question ffffffff/);
  fails(["answer", row.id, "maybe"], OWNER, /usage/);
});

test("the answer no tells the session not to act, and an old question takes no answer", () => {
  const text = compose(layoutOfAnswer({ id: "ab12cd34", question: "Push to main?", answer: "no", via: "the command line" }));
  assert.match(text.slice(text.lastIndexOf(RULE)), /Your user said no\. Do not do that action\./);
  const old = asks.put({ from: { vendor: "cursor", id: "s-1", name: "worker" }, question: "Old?", now: Date.now() - asks.ASK_TTL_MS - 1000 });
  assert.equal(asks.waiting().some((r) => r.id === old.id), false);
  assert.throws(() => asks.answer(old.id, true), /older than 24 hours/);
});

test("the history holds each answer, the newest first, and no question that waits", () => {
  const from = { vendor: "cursor", id: "s-1", name: "worker" };
  const first = asks.put({ from, question: "First?" });
  const second = asks.put({ from, question: "Second?" });
  asks.put({ from, question: "Still waits?" });
  asks.answer(first.id, false, { now: Date.now() + 1000 });
  asks.answer(second.id, true, { now: Date.now() + 2000 });
  const done = asks.history();
  assert.deepEqual(done.slice(0, 2).map((r) => [r.question, r.answer]), [["Second?", "yes"], ["First?", "no"]]);
  assert.equal(done.some((r) => r.question === "Still waits?"), false);
  assert.match(run(["asks", "--history"]), /yes +cursor:worker +through the command line\n +Second\?/);
});

// A review: a screenshot and options, and the answer is a choice and a comment.
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

test("a session asks for a review, and openmsg keeps a copy of each image", () => {
  const shot = path.join(HOME, "board.png");
  fs.writeFileSync(shot, PNG);
  const out = run(["ask", "Which concept?", "--image", shot, "--option", "A — Mapa", "--option", "B — Lista"], { ...OWNER, OPENMSG_SELF: "cursor:worker" });
  assert.match(out, /The review [0-9a-f]{8} waits/);
  fs.rmSync(shot);
  const row = asks.waiting().find((r) => r.question === "Which concept?");
  assert.equal(row.kind, "review");
  assert.deepEqual(row.options, ["A — Mapa", "B — Lista"]);
  const [copy] = JSON.parse(run(["asks", "--json"])).find((r) => r.id === row.id).images;
  assert.equal(fs.readFileSync(copy).equals(PNG), true);
});

test("a review refuses a page, a missing file, and one option", () => {
  const from = { vendor: "cursor", id: "s-1", name: "worker" };
  const page = path.join(HOME, "a.html");
  fs.writeFileSync(page, "<p>");
  assert.throws(() => asks.put({ from, question: "Q?", images: [page] }), /send a screenshot/);
  assert.throws(() => asks.put({ from, question: "Q?", images: [path.join(HOME, "none.png")] }), /no file/);
  assert.throws(() => asks.put({ from, question: "Q?", options: ["only"] }), /two options/);
  assert.throws(() => asks.put({ from, question: "Q?", options: ["x", "x"] }), /same text/);
});

test("a review takes a choice and a comment, and not yes or no", () => {
  const row = asks.waiting().find((r) => r.question === "Which concept?");
  fails(["answer", row.id, "yes"], OWNER, /is a review/);
  fails(["answer", row.id, "--choice", "C"], OWNER, /no option "C"/);
  fails(["answer", row.id, "--comment", "x"], { ...OWNER, CLAUDECODE: "1" }, /only the owner answers/);
  const copy = path.join(asks.filesDir(), row.images[0]);
  assert.match(run(["answer", row.id, "--choice", "2", "--comment", "Mais contraste", "--via", "the approval app"]), /"B — Lista" is the answer/);
  assert.equal(fs.existsSync(copy), false);
  const inbox = run(["inbox"], { ...OWNER, OPENMSG_SELF: "cursor:worker" });
  assert.match(inbox, /Question: Which concept\?\nChoice: B — Lista\nComment: Mais contraste/);
  assert.match(inbox, /the choice and the feedback of your user/);
  assert.match(run(["asks", "--history"]), /chose: B — Lista\n +comment: Mais contraste/);
});

test("an approval takes no choice", () => {
  const row = asks.put({ from: { vendor: "cursor", id: "s-1", name: "worker" }, question: "Push?" });
  fails(["answer", row.id, "--choice", "1"], OWNER, /takes yes or no/);
  fails(["answer", row.id], OWNER, /usage/);
});
