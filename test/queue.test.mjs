// Tests for the message that waits with its sender. The relay does not run
// when Alice sends, as when its machine sleeps. The message waits in the
// outbox of Alice, and it goes when the relay answers again.
// Run: node --test
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const CLI = path.join(ROOT, "src/cli.mjs");
const ALICE = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-qa-"));
const BOB = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-qb-"));
process.env.OPENMSG_RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-qr-"));

const identity = await import("../src/identity.mjs");
const directory = await import("../src/directory.mjs");
const invite = await import("../src/invite.mjs");
const permissions = await import("../src/permissions.mjs");
const published = await import("../src/published.mjs");
const outbox = await import("../src/outbox.mjs");
const remote = await import("../src/remote.mjs");
const gateway = await import("../src/gateway.mjs");
const relay = await import("../src/relay.mjs");
const relaylink = await import("../src/relaylink.mjs");
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

const alice = as(ALICE, () => identity.create({ label: "alice" }));
const bob = as(BOB, () => identity.create({ label: "bob" }));
const SESSION = { vendor: "cursor", id: "conv-queue", name: "reviewer" };
as(BOB, () => register({ ...SESSION, cwd: "/work" }));
const offer = as(ALICE, () => invite.create({ label: "web-app" }));
const taken = as(BOB, () => invite.accept(offer.token, offer.fingerprint));
as(ALICE, () => invite.accept(taken.reply.token, taken.mine));
const PROJECT = offer.project.id;
as(BOB, () => published.publish(PROJECT, SESSION));
as(BOB, () => permissions.set(PROJECT, alice.ownerId, "accept"));

// A port that nothing listens on now. The relay starts there later.
const first = await relay.serve({ port: 0, host: "127.0.0.1" });
const PORT = first.port;
await first.close();
const RELAY_URL = `ws://127.0.0.1:${PORT}`;
as(ALICE, () => gateway.saveSettings({ relay: RELAY_URL }));

let running = null;
after(async () => {
  await running?.close();
});

const cli = (args) =>
  run(process.execPath, [CLI, ...args], { env: { ...process.env, OPENMSG_HOME: ALICE, OPENMSG_SELF: "claude:api-worker" } });
const routingRow = { alias: "cursor:reviewer", vendor: "cursor", name: "reviewer", owner: bob.ownerId, project: PROJECT, session: SESSION.id, epoch: 1, live: true };

test("with no relay and no routing data, the send fails and says why", async () => {
  await assert.rejects(cli(["send", "cursor:reviewer@bob", "to nobody"]), /no routing data for bob/);
  assert.equal(as(ALICE, () => outbox.list()).length, 0);
});

let waitingId = null;
test("with no relay, a message waits in the outbox of the sender, with a deadline of a day", async () => {
  as(ALICE, () => directory.setRouting(PROJECT, bob.ownerId, [routingRow]));
  const { stdout } = await cli(["send", "cursor:reviewer@bob", "MARKER-QUEUE: read this when you are back"]);
  assert.match(stdout, /waits on this machine for bob, because the relay does not answer/);
  const rows = as(ALICE, () => outbox.list());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "queued");
  assert.equal(rows[0].pending, true);
  waitingId = rows[0].messageId;
  const life = Date.parse(rows[0].wire.expiresAt) - Date.parse(rows[0].wire.createdAt);
  assert.equal(life, remote.WAIT_TTL_MS);
  assert.match((await cli(["outbox"])).stdout, /on this machine, the relay did not answer/);
});

test("a message that passed its deadline in the outbox does not go", async () => {
  const old = as(ALICE, () => {
    const message = remote.createRemote({
      from: { owner: alice.ownerId, vendor: "claude", id: "ses_alice", name: "api-worker" },
      project: { id: PROJECT, label: "web-app" },
      target: { owner: bob.ownerId, project: PROJECT, session: SESSION.id, epoch: 1 },
      text: "MARKER-OLD",
      now: Date.now() - 2 * remote.WAIT_TTL_MS,
      ttlMs: remote.WAIT_TTL_MS,
    });
    const wire = remote.pack(message, { recipient: directory.member(PROJECT, bob.ownerId) });
    outbox.put({ messageId: message.messageId, to: bob.ownerId, project: PROJECT, wire, state: "queued", pending: true });
    return message.messageId;
  });

  running = await relay.serve({ port: PORT, host: "127.0.0.1" });
  const arrived = [];
  const bobLink = await asAsync(BOB, () => relaylink.open(RELAY_URL, { onDeliver: (frame) => arrived.push(frame) }));
  const aliceLink = await asAsync(ALICE, () => relaylink.open(RELAY_URL));
  const logs = [];
  const out = await asAsync(ALICE, () => gateway.flushOutbox(aliceLink, { log: (l) => logs.push(l) }));
  assert.equal(out.sent, 1);
  assert.equal(as(ALICE, () => outbox.find(old)).state, "expired");

  // The message that waited goes one time, and Bob takes it.
  const row = as(ALICE, () => outbox.find(waitingId));
  assert.equal(row.state, "queued");
  assert.equal(row.pending, false);
  for (let i = 0; i < 100 && arrived.length === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.equal(arrived.length, 1);
  assert.equal(arrived[0].wire.messageId, waitingId);

  let read = null;
  const got = await asAsync(BOB, () =>
    gateway.receive(arrived[0].wire, { via: "relay", deliver: async (agent, message, { text }) => {
      read = text;
      return { delivered: true, transport: "stub" };
    } }),
  );
  assert.equal(got.status, "adapter-accepted");
  assert.match(read, /MARKER-QUEUE/);

  // A second look at the outbox sends nothing again.
  assert.equal((await asAsync(ALICE, () => gateway.flushOutbox(aliceLink))).sent, 0);
  aliceLink.close();
  bobLink.close();
});

test("the gateway of the sender sends the outbox when its connection opens", async () => {
  as(ALICE, () => {
    const message = remote.createRemote({
      from: { owner: alice.ownerId, vendor: "claude", id: "ses_alice", name: "api-worker" },
      project: { id: PROJECT, label: "web-app" },
      target: { owner: bob.ownerId, project: PROJECT, session: SESSION.id, epoch: 1 },
      text: "MARKER-GATEWAY",
      ttlMs: remote.WAIT_TTL_MS,
    });
    const wire = remote.pack(message, { recipient: directory.member(PROJECT, bob.ownerId) });
    outbox.put({ messageId: message.messageId, to: bob.ownerId, project: PROJECT, wire, state: "queued", pending: true });
  });
  // The home of Alice stays for the life of the connection, as in a gateway.
  process.env.OPENMSG_HOME = ALICE;
  const holder = await gateway.joinRelay(RELAY_URL, { flushMs: 50 });
  try {
    let left = 1;
    for (let i = 0; i < 150 && left > 0; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      left = outbox.list().filter((r) => r.pending).length;
    }
    assert.equal(left, 0, "no message waits in the outbox");
  } finally {
    holder.stop();
    delete process.env.OPENMSG_HOME;
  }
});
