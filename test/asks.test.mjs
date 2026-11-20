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
