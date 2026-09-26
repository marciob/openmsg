// Tests for the states and the limits of phase 5: the seven states, the
// acknowledgement of an agent, the conflict rule, and the three limits.
// Run: node --test
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const ALICE = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-sa-"));
const BOB = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-sb-"));

const identity = await import("../src/identity.mjs");
const directory = await import("../src/directory.mjs");
const invite = await import("../src/invite.mjs");
const permissions = await import("../src/permissions.mjs");
const published = await import("../src/published.mjs");
const inbound = await import("../src/inbound.mjs");
const outbox = await import("../src/outbox.mjs");
const limits = await import("../src/limits.mjs");
const remote = await import("../src/remote.mjs");
const gateway = await import("../src/gateway.mjs");
const { register } = await import("../src/selfregistry.mjs");

function as(home, fn) {
  const before = process.env.OPENMSG_HOME;
  process.env.OPENMSG_HOME = home;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.OPENMSG_HOME;
    else process.env.OPENMSG_HOME = before;
  }
}
async function asAsync(home, fn) {
  const before = process.env.OPENMSG_HOME;
  process.env.OPENMSG_HOME = home;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.OPENMSG_HOME;
    else process.env.OPENMSG_HOME = before;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const alice = as(ALICE, () => identity.create({ label: "alice" }));
const bob = as(BOB, () => identity.create({ label: "bob" }));
const SESSION = { vendor: "cursor", id: "conv-states", name: "reviewer" };
as(BOB, () => register({ ...SESSION, cwd: "/work" }));
const offer = as(ALICE, () => invite.create({ label: "web-app" }));
const taken = as(BOB, () => invite.accept(offer.token, offer.fingerprint));
as(ALICE, () => invite.accept(taken.reply.token, taken.mine));
const PROJECT = offer.project.id;
as(BOB, () => published.publish(PROJECT, SESSION));
as(BOB, () => permissions.set(PROJECT, alice.ownerId, "accept"));

let delivered = [];
const stub = async (agent, message, { text }) => {
  delivered.push(text);
  return { delivered: true, transport: "stub" };
};

function letter(text, messageId = null) {
  return as(ALICE, () => {
    const message = remote.createRemote({
      from: { owner: alice.ownerId, vendor: "claude", id: "ses_alice", name: "api-worker" },
      project: { id: PROJECT, label: "web-app" },
      target: { owner: bob.ownerId, project: PROJECT, session: SESSION.id, epoch: 1 },
      text,
    });
    if (messageId) message.messageId = messageId;
    return remote.pack(message, { recipient: directory.member(PROJECT, bob.ownerId) });
  });
}

const receive = (wire, options = {}) => asAsync(BOB, () => gateway.receive(wire, { deliver: stub, ...options }));

test("the store takes the seven states, and no other word", () => {
  assert.deepEqual(inbound.STATES, [
    "queued",
    "held",
    "adapter-accepted",
    "agent-acknowledged",
    "replied",
    "refused",
    "expired",
  ]);
  as(BOB, () => {
    assert.throws(() => inbound.put({ messageId: "x", status: "delivered" }), /not a state/);
    assert.throws(() => inbound.put({ messageId: "x", status: "read" }), /not a state/);
  });
});

test("a message reaches the agent, and only an event of the agent acknowledges it", async () => {
  const wire = letter("read me");
  const out = await receive(wire);
  assert.equal(out.status, "adapter-accepted");
  assert.equal(delivered.length, 1);
  // The text tells the agent how to say that it read the message.
  assert.match(delivered[0], /openmsg ack [0-9a-f]{8}/);
  assert.match(delivered[0], /--reply-to/);

  const row = as(BOB, () => inbound.find(wire.messageId));
  assert.equal(row.status, "adapter-accepted", "a write to an adapter is not a read by a model");
  as(BOB, () => inbound.setStatus(wire.messageId, "agent-acknowledged"));
  assert.equal(as(BOB, () => inbound.find(wire.messageId)).status, "agent-acknowledged");
});

test("two messages with one id and different content: the second is refused", async () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const first = letter("the true text", id);
  const second = letter("another text", id);
  assert.equal(first.messageId, second.messageId);

  const one = await receive(first);
  assert.equal(one.status, "adapter-accepted");
  const read = delivered.length;

  const two = await receive(second);
  assert.equal(two.status, "refused");
  assert.equal(two.reason, "conflict");
  assert.equal(delivered.length, read, "the second content never reached the agent");
  const row = as(BOB, () => inbound.find(id));
  assert.equal(row.status, "adapter-accepted", "the record of the first message holds");
  assert.match(row.message.parts[0].text, /the true text/);
  assert.ok(row.conflictAt, "the store reports the event");
});

test("the same message again reaches the agent one time", async () => {
  const wire = letter("say this one time");
  await receive(wire);
  const read = delivered.length;
  const again = await receive(wire);
  assert.equal(again.reason, "duplicate");
  assert.equal(delivered.length, read);
});

test("the three limits each stop a message in their own way", () => {
  const now = Date.now();
  const at = (ms) => new Date(now - ms).toISOString();
  const caps = { ...limits.DEFAULTS, senderPerWindow: 3, turnsPerSession: 2, heldMax: 2 };
  const from = (n, extra = {}) =>
    Array.from({ length: n }, (_, i) => ({
      messageId: `m${i}${extra.status ?? ""}`,
      from: { owner: alice.ownerId },
      project: PROJECT,
      target: { session: SESSION.id },
      status: "adapter-accepted",
      receivedAt: at(1000),
      ...extra,
    }));

  assert.equal(limits.check(from(2), { owner: alice.ownerId, project: PROJECT, session: "other", now, limits: caps }), null);

  const fast = limits.check(from(3), { owner: alice.ownerId, project: PROJECT, session: "other", now, limits: caps });
  assert.equal(fast.action, "refuse");
  assert.equal(fast.reason, "rate-limit");

  // A message that arrived outside the window does not count.
  const old = limits.check(from(3, { receivedAt: at(60_000) }), {
    owner: alice.ownerId,
    project: PROJECT,
    session: "other",
    now,
    limits: { ...caps, senderWindowMs: 1000 },
  });
  assert.equal(old, null);

  const busy = limits.check(from(2), { owner: alice.ownerId, project: PROJECT, session: SESSION.id, now, limits: { ...caps, senderPerWindow: 30 } });
  assert.equal(busy.action, "hold", "a turn limit holds the message, and loses no work");
  assert.equal(busy.reason, "turn-limit");

  const full = limits.check(from(2, { status: "held" }), { owner: alice.ownerId, project: PROJECT, session: "other", now, limits: { ...caps, senderPerWindow: 30 } });
  assert.equal(full.action, "refuse");
  assert.equal(full.reason, "queue-full");
});

test("the turn limit holds a real message, outside the model", async () => {
  fs.rmSync(path.join(BOB, "inbound.jsonl"), { force: true });
  fs.writeFileSync(path.join(BOB, "limits.json"), JSON.stringify({ turnsPerSession: 2 }));
  delivered = [];
  assert.equal((await receive(letter("one"))).status, "adapter-accepted");
  assert.equal((await receive(letter("two"))).status, "adapter-accepted");
  const third = await receive(letter("three"));
  assert.equal(third.status, "held");
  assert.equal(third.reason, "turn-limit");
  assert.equal(delivered.length, 2, "the third message waits for the owner");

  // The owner accepts it, and the limit does not stop the owner.
  const held = as(BOB, () => inbound.list({ status: "held" }))[0];
  const out = await asAsync(BOB, () => gateway.release(held, { deliver: stub }));
  assert.equal(out.status, "adapter-accepted");
  assert.equal(delivered.length, 3);
  fs.rmSync(path.join(BOB, "limits.json"), { force: true });
});

test("an acknowledgement travels back to the sender over a direct address", async () => {
  // The gateway of Alice runs in its own process, and it takes the receipt.
  const script = path.join(ALICE, "gateway.mjs");
  fs.writeFileSync(
    script,
    `const gateway = await import(${JSON.stringify(path.join(ROOT, "src/gateway.mjs"))});
     const running = await gateway.serve({ port: 0, host: "127.0.0.1" });
     console.log(JSON.stringify({ url: running.url }));`,
  );
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, OPENMSG_HOME: ALICE },
    stdio: ["ignore", "pipe", "pipe"],
  });
  after(() => child.kill());
  const url = await new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`no gateway: ${out}`)), 10_000);
    child.stdout.on("data", (d) => {
      out += d;
      const line = out.split("\n").find((l) => l.startsWith("{"));
      if (line) {
        clearTimeout(timer);
        resolve(JSON.parse(line).url);
      }
    });
    child.stderr.on("data", (d) => (out += d));
  });
  as(BOB, () => directory.setEndpoint(PROJECT, alice.ownerId, url));

  const wire = letter("tell me when you read it");
  as(ALICE, () => outbox.put({ messageId: wire.messageId, to: bob.ownerId, project: PROJECT, state: "queued" }));
  assert.equal((await receive(wire)).status, "adapter-accepted");

  const row = as(BOB, () => inbound.find(wire.messageId));
  as(BOB, () => inbound.setStatus(wire.messageId, "agent-acknowledged"));
  const told = await asAsync(BOB, () => gateway.reportState(row, "agent-acknowledged"));
  assert.equal(told.sent, true);
  assert.equal(told.how, "http");
  await sleep(200);
  assert.equal(as(ALICE, () => outbox.find(wire.messageId)).state, "agent-acknowledged");

  // A receipt for a message that this owner never sent changes nothing.
  const strange = as(BOB, () => gateway.reportState({ ...row, messageId: "no-such-message" }, "replied"));
  await assert.rejects(strange, /404|no such message/);
});
