// A webhook agent that waits for a message in its turn: `openmsg inbox
// --wait`, and the adapter that sends no second notice. Rule 8 of section
// 7.1 of the spec of 0.1.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-wake-"));
process.env.OPENMSG_HOME = HOME;
const mailbox = await import("../src/mailbox.mjs");
const { deliverLocal } = await import("../src/deliver.mjs");

after(() => fs.rmSync(HOME, { recursive: true, force: true }));

// Port 9 on the loopback answers nothing, so a notice there fails.
const AGENT = { vendor: "webhook", id: "grok", name: "grok", transport: { kind: "webhook", url: "http://127.0.0.1:9/hook", headers: {} } };
const message = (id) => ({
  messageId: id,
  createdAt: new Date().toISOString(),
  openmsg: { from: { vendor: "claude", id: "ses_a", name: "a" }, hops: [] },
  parts: [{ kind: "text", text: "hello" }],
});

test("a wait counts only while its process runs and its end has not passed", () => {
  mailbox.markWaiting(AGENT, Date.now() + 5000);
  assert.equal(mailbox.isWaiting(AGENT), true);
  assert.equal(mailbox.isWaiting(AGENT, { now: Date.now() + 6000 }), false, "the end passed");
  mailbox.markWaiting(AGENT, Date.now() + 5000, 2 ** 22 + 12345);
  assert.equal(mailbox.isWaiting(AGENT), false, "the process stopped");
  mailbox.clearWaiting(AGENT, 2 ** 22 + 12345);
  assert.equal(mailbox.isWaiting(AGENT), false);
});

test("a message for an agent that waits goes to the mailbox with no notice", async () => {
  mailbox.markWaiting(AGENT, Date.now() + 5000);
  const out = await deliverLocal(AGENT, message("11111111-1111-4111-8111-111111111111"), { text: "hello" });
  assert.equal(out.transport, "mailbox-read-waits");
  assert.equal(out.delivered, true);
  assert.equal(mailbox.list(AGENT, { unreadOnly: true }).length, 1);
  mailbox.clearWaiting(AGENT);

  // With no wait, the adapter sends the notice. Here it fails, and the
  // message still waits in the mailbox.
  const plain = await deliverLocal(AGENT, message("22222222-2222-4222-8222-222222222222"), { text: "hello" });
  assert.equal(plain.transport, "mailbox");
  assert.match(plain.detail, /did not answer/);
});

test("openmsg inbox --wait returns when a message arrives", async () => {
  mailbox.markRead(AGENT, mailbox.list(AGENT, { unreadOnly: true }).map((m) => m.messageId));
  const child = spawn(process.execPath, [path.join(ROOT, "src/cli.mjs"), "inbox", "--wait", "8"], {
    env: { ...process.env, OPENMSG_HOME: HOME, OPENMSG_SELF: "webhook:grok" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const started = Date.now();
  // The command marks the wait, and the message arrives while it waits.
  for (let i = 0; i < 50 && !mailbox.isWaiting(AGENT); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(mailbox.isWaiting(AGENT), true, `the command waits: ${out}`);
  mailbox.put(AGENT, { ...message("33333333-3333-4333-8333-333333333333"), rendered: "the waited text" }, "queued");
  const code = await new Promise((r) => child.on("close", r));
  assert.equal(code, 0, out);
  assert.match(out, /the waited text/);
  assert.ok(Date.now() - started < 6000, "it did not wait until the end");
  assert.equal(mailbox.isWaiting(AGENT), false, "the wait file is gone");
});
