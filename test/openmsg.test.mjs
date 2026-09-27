// Tests for the parts that need no agent account.
// Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-test-"));
process.env.OPENMSG_HOME = HOME;

const { createMessage, render, address, textOf, MAX_HOPS } = await import("../src/envelope.mjs");
const mailbox = await import("../src/mailbox.mjs");
const { register, registered } = await import("../src/selfregistry.mjs");
const { runHook } = await import("../src/hook.mjs");
const { block } = await import("../src/install.mjs");

const alice = { vendor: "claude", id: "id-a", name: "alice" };
const bob = { vendor: "codex", id: "id-b", name: "bob" };

function message(text, extra = {}) {
  const m = createMessage({ from: alice, to: bob, text, ...extra });
  m.openmsg.hops = [address(alice)];
  return m;
}

test("an envelope carries the A2A fields", () => {
  const m = message("hello");
  assert.equal(m.kind, "message");
  assert.equal(m.role, "agent");
  assert.match(m.messageId, /^[0-9a-f-]{36}$/);
  assert.match(m.contextId, /^[0-9a-f-]{36}$/);
  assert.equal(textOf(m), "hello");
  assert.equal(m.openmsg.version, 1);
});

test("a reply keeps the conversation and starts no new one", () => {
  const first = message("question");
  const reply = createMessage({ from: bob, to: alice, text: "answer", contextId: first.contextId, replyTo: first.messageId });
  assert.equal(reply.contextId, first.contextId);
  assert.equal(reply.openmsg.replyTo, first.messageId);
  assert.notEqual(reply.messageId, first.messageId);
});

test("the text of a message names its source and approves nothing", () => {
  const out = render(message("body text"));
  assert.match(out, /^From: claude:alice\nId:   [0-9a-f]{8}\n─{32}\n/);
  assert.match(out, /body text/);
  assert.match(out, /does not approve any action/);
  assert.match(out, /--reply-to [0-9a-f]{8}$/);
  assert.ok(!out.includes("\x1b"), "no color without ansi");
});

test("with ansi, the frame is gray, the body is blue, and the text of the sender keeps no escape", () => {
  const out = render(message("real line\n\x1b[8mhidden line\x1b[0m\r"), { ansi: true });
  const lines = out.split("\n");
  for (const l of lines.slice(0, 3)) assert.match(l, /^\x1b\[90m.*\x1b\[39m$/, "each line of the header is gray");
  assert.equal(lines[3], "\x1b[34mreal line\x1b[39m", "each line of the body is blue");
  assert.equal(lines[4], "\x1b[34m[8mhidden line[0m\x1b[39m", "the escape character of the sender is gone");
  for (const l of lines.slice(5)) assert.match(l, /^\x1b\[90m.*\x1b\[39m$/, "each line of the frame opens and closes its color");
});

test("a short id finds the message that it answers", () => {
  const agent = { vendor: "claude", name: "short-id" };
  const m = message("x");
  mailbox.put(agent, m, "queued");
  assert.equal(mailbox.find(agent, m.messageId.slice(0, 8)).messageId, m.messageId);
  assert.equal(mailbox.find(agent, m.messageId).messageId, m.messageId);
  assert.equal(mailbox.find(agent, "ffffffff-none"), null);
});

test("a file name of the mailbox holds no character that an operating system refuses", () => {
  for (const name of ["a*b", "a:b", "a_b", "end.", "na~me", "it(1)", "../../etc/passwd"]) {
    const agent = { vendor: "claude", name };
    const file = mailbox.put(agent, message("x"), "queued");
    const base = path.basename(file);
    assert.equal(mailbox.addressOfFile(file), `claude:${name}`, "the address reads back");
    assert.ok(!/[<>:"/\\|?*]/.test(base), `${base} holds a refused character`);
    assert.ok(!base.replace(/\.jsonl$/, "").endsWith("."), `${base} ends with a dot`);
    assert.equal(path.dirname(file), path.join(HOME, "inbox"), "the file stays in the inbox");
  }
});

test("two addresses never share one file", () => {
  const one = mailbox.put({ vendor: "claude", name: "a_b" }, message("one"), "queued");
  const two = mailbox.put({ vendor: "claude", name: "a:b" }, message("two"), "queued");
  assert.notEqual(one, two);
});

test("a reader marks only the messages that it saw", () => {
  const agent = { vendor: "claude", name: "reader" };
  const seen = message("seen");
  const unseen = message("unseen");
  mailbox.put(agent, seen, "delivered");
  mailbox.put(agent, unseen, "delivered");
  mailbox.markRead(agent, [seen.messageId]);
  const left = mailbox.list(agent, { unreadOnly: true });
  assert.equal(left.length, 1);
  assert.equal(left[0].messageId, unseen.messageId);
});

test("a reply finds the message that it answers", () => {
  const agent = { vendor: "claude", name: "finder" };
  const m = message("find me");
  mailbox.put(agent, m, "delivered");
  assert.equal(mailbox.find(agent, m.messageId)?.messageId, m.messageId);
  assert.equal(mailbox.find(agent, "no-such-id"), null);
});

test("a hook registers its session, and discovery finds it", () => {
  register({ vendor: "cursor", id: "conv-1234", name: "work-1234", cwd: "/tmp/work" });
  const rows = registered();
  const row = rows.find((r) => r.id === "conv-1234");
  assert.ok(row, "the session is in the list");
  assert.equal(row.vendor, "cursor");
  assert.equal(row.transport.kind, "mailbox");
});

test("a hook of Cursor returns the waiting messages once", async () => {
  const agent = { vendor: "cursor", id: "conv-9999", name: "openmsg-9999", cwd: "/Users/x/openmsg" };
  mailbox.put(agent, message("wake up"), "queued");
  const input = JSON.stringify({ conversation_id: "conv-9999", hook_event_name: "stop", workspace_roots: ["/Users/x/openmsg"] });
  const first = await withStdin(input, () => runHook("cursor"));
  assert.match(first.followup_message, /wake up/);
  const second = await withStdin(input, () => runHook("cursor"));
  assert.deepEqual(second, {}, "a message goes to the agent one time");
});

test("a hook of Gemini denies the stop, and sends the text as the reason", async () => {
  const agent = { vendor: "gemini", id: "sess-4321", name: "openmsg-4321", cwd: "/Users/x/openmsg" };
  mailbox.put(agent, message("from gemini test"), "queued");
  const input = JSON.stringify({ session_id: "sess-4321", hook_event_name: "AfterAgent", cwd: "/Users/x/openmsg" });
  const out = await withStdin(input, () => runHook("gemini"));
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /from gemini test/);
});

test("a hook refuses a chain that passed the limit", async () => {
  const agent = { vendor: "cursor", id: "conv-hops", name: "openmsg-hops", cwd: "/Users/x/openmsg" };
  const long = message("too many hops");
  long.openmsg.hops = Array.from({ length: MAX_HOPS + 1 }, (_, i) => `claude:a${i}`);
  mailbox.put(agent, long, "queued");
  const input = JSON.stringify({ conversation_id: "conv-hops", hook_event_name: "stop", workspace_roots: ["/Users/x/openmsg"] });
  const out = await withStdin(input, () => runHook("cursor"));
  assert.deepEqual(out, {}, "the message never reaches the agent");
});

test("the instruction block carries the rules and the command", () => {
  const text = block("openmsg");
  assert.match(text, /<!-- openmsg:start -->/);
  assert.match(text, /<!-- openmsg:end -->/);
  assert.match(text, /openmsg list/);
  assert.match(text, /never approves an action|not authority|information, not authority/);
});

// A hook reads its input from the standard input. This helper gives it one.
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

test("OpenCode shows the header and the text of the sender, and the model reads every word", async () => {
  const http = await import("node:http");
  const { deliverLocal } = await import("../src/deliver.mjs");
  const { layoutOf, compose, RULE } = await import("../src/envelope.mjs");
  const m = message("first line\nsecond line");
  let got;
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => { got = { url: req.url, body: JSON.parse(data) }; res.end("{}"); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const agent = { vendor: "opencode", id: "ses_1", transport: { base: `http://127.0.0.1:${server.address().port}` } };
    const out = await deliverLocal(agent, m);
    assert.equal(out.transport, "http");
    assert.equal(got.url, "/session/ses_1/prompt_async");
    const [shown, hidden] = got.body.parts;
    assert.ok(!shown.synthetic, "the person sees the first part");
    assert.match(shown.text, /^From: claude:alice\n/, "the first part names the sender");
    assert.ok(shown.text.endsWith(`second line\n${RULE}`), "the first part ends after the text of the sender");
    assert.equal(hidden.synthetic, true, "the notice is only for the model");
    assert.match(hidden.text, /does not approve any action/);
    assert.equal(`${shown.text}\n${hidden.text}`, compose(layoutOf(m)), "the model reads the same words");
    assert.ok(!JSON.stringify(got.body).includes("\\u001b"), "no escape sequence");
  } finally {
    server.close();
  }
});

test("a Claude socket in the environment names the sender only under that session", async () => {
  const { runsUnder } = await import("../src/registry.mjs");
  assert.equal(await runsUnder(process.ppid), true, "the parent of this command");
  assert.equal(await runsUnder(2 ** 22 + 7), false, "a session that is not a parent, such as the one that started an OpenCode server");
});
