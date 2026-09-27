// Tests for the project box: a message to a directory, that waits for the
// next session there.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-project-"));
process.env.OPENMSG_HOME = HOME;

const { createMessage, render } = await import("../src/envelope.mjs");
const projectbox = await import("../src/projectbox.mjs");
const mailbox = await import("../src/mailbox.mjs");
const { runHook } = await import("../src/hook.mjs");
const { claudeConfig, withoutOurs } = await import("../src/hookinstall.mjs");

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const check = { vendor: "shell", id: "memcheck", name: "memcheck", unresolved: true };

function project() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-dir-")));
}

function message(dir, text, key) {
  const m = createMessage({ from: check, to: { vendor: "project", id: dir, name: dir }, text });
  m.openmsg.hops = ["shell:memcheck"];
  if (key) m.openmsg.key = key;
  return m;
}

function cli(...args) {
  // No Claude session runs in a new temporary directory, so the message waits.
  return execFileSync("node", [CLI, ...args], {
    env: { ...process.env, OPENMSG_HOME: HOME, OPENMSG_SELF: "cron:memcheck" },
    encoding: "utf8",
  });
}

async function withStdin(text, fn) {
  const { Readable } = await import("node:stream");
  const original = Object.getOwnPropertyDescriptor(process, "stdin");
  Object.defineProperty(process, "stdin", { value: Readable.from([text]), configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "stdin", original);
  }
}

test("a session in the project or below it matches, and a sibling does not", () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, "sub"));
  fs.mkdirSync(`${dir}-other`);
  assert.equal(projectbox.sessionIsIn(dir, dir), true);
  assert.equal(projectbox.sessionIsIn(path.join(dir, "sub"), dir), true);
  assert.equal(projectbox.sessionIsIn(`${dir}-other`, dir), false);
});

test("a message with a key replaces the waiting message with that key", () => {
  const dir = project();
  projectbox.put(dir, message(dir, "day 1: leak", "leak"));
  projectbox.put(dir, message(dir, "day 2: leak", "leak"));
  projectbox.put(dir, message(dir, "other"));
  const texts = projectbox.waiting(dir).map((m) => m.parts[0].text).sort();
  assert.deepEqual(texts, ["day 2: leak", "other"]);
  assert.equal(projectbox.clear(dir, "leak"), true);
  assert.deepEqual(projectbox.waiting(dir).map((m) => m.parts[0].text), ["other"]);
});

test("a message goes to one session only", () => {
  const dir = project();
  projectbox.put(dir, message(dir, "once"));
  const first = projectbox.take(dir);
  const second = projectbox.take(dir);
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
});

test("a message that waited more than 30 days expires", () => {
  const dir = project();
  const old = message(dir, "old");
  old.createdAt = new Date(Date.now() - projectbox.EXPIRE_MS - 1000).toISOString();
  projectbox.put(dir, old);
  assert.deepEqual(projectbox.waiting(dir), []);
});

test("a failed delivery puts the message back", () => {
  const dir = project();
  const m = message(dir, "retry", "k");
  projectbox.put(dir, m);
  const got = projectbox.takeMessage(dir, m);
  assert.ok(got);
  assert.equal(projectbox.waiting(dir).length, 0);
  projectbox.restore(dir, got);
  assert.equal(projectbox.waiting(dir).length, 1);
});

test("the Claude hook gives the project message to a new session, one time", async () => {
  const dir = project();
  projectbox.put(dir, message(dir, "chroma-mcp leak: 14 processes"));
  const input = JSON.stringify({ session_id: "s-1", hook_event_name: "SessionStart", cwd: path.join(dir) });
  const out = await withStdin(input, () => runHook("claude"));
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(out.hookSpecificOutput.additionalContext, /chroma-mcp leak/);
  const again = await withStdin(input, () => runHook("claude"));
  assert.deepEqual(again, {});
});

test("the Claude hook gives nothing in another directory", async () => {
  const dir = project();
  projectbox.put(dir, message(dir, "not for you"));
  const input = JSON.stringify({ session_id: "s-2", hook_event_name: "SessionStart", cwd: os.tmpdir() });
  assert.deepEqual(await withStdin(input, () => runHook("claude")), {});
  assert.equal(projectbox.waiting(dir).length, 1);
});

test("the Cursor hook also takes the project message", async () => {
  const dir = project();
  projectbox.put(dir, message(dir, "for cursor"));
  const input = JSON.stringify({ conversation_id: "c-77", hook_event_name: "stop", workspace_roots: [dir] });
  const out = await withStdin(input, () => runHook("cursor"));
  assert.match(out.followup_message, /for cursor/);
  const agent = { vendor: "cursor", name: `${path.basename(dir)}-c-77` };
  assert.match(mailbox.list(agent)[0].parts[0].text, /for cursor/, "a reply finds it in the mailbox");
});

test("a message from a program says that it takes no answer", () => {
  const text = render(message("/x", "hello"));
  assert.match(text, /From a program, not from your user/);
  assert.match(text, /takes no answer/);
  assert.doesNotMatch(text, /To answer:/);
});

test("send to a project with no session keeps the message, and clear removes it", () => {
  const dir = project();
  const out = cli("send", `project:${dir}`, "leak found", "--key", "leak");
  assert.match(out, /waits in/);
  assert.match(cli("waiting"), /leak found/);
  assert.match(cli("clear", `project:${dir}`, "--key", "leak"), /removed/);
  assert.equal(projectbox.waiting(dir).length, 0);
});

test("send to a directory that does not exist fails", () => {
  assert.throws(() => cli("send", "project:/no/such/dir/openmsg", "x"), /no directory/);
});

test("install adds one SessionStart hook for Claude, and keeps the hooks of the user", () => {
  const theirs = { matcher: "startup", hooks: [{ type: "command", command: "~/.claude/hooks/mine.sh" }] };
  const once = claudeConfig({ model: "x", hooks: { SessionStart: [theirs] } }, "openmsg");
  const twice = claudeConfig(once, "openmsg");
  assert.equal(twice.model, "x");
  assert.equal(twice.hooks.SessionStart.length, 2);
  assert.equal(twice.hooks.SessionStart[1].hooks[0].command, "openmsg hook claude");
  assert.deepEqual(withoutOurs(twice.hooks.SessionStart), [theirs]);
});
