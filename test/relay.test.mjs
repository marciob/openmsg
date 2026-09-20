// Tests for the relay of phase 4. The relay runs in this process, and the two
// gateways run in their own processes, as two people on one machine.
// Run: node --test
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const ALICE = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-ra-"));
const BOB = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-rb-"));
const RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-relay-"));
const STUB_OUT = path.join(BOB, "agent-read.txt");
process.env.OPENMSG_RELAY_HOME = RELAY_HOME;

const identity = await import("../src/identity.mjs");
const directory = await import("../src/directory.mjs");
const invite = await import("../src/invite.mjs");
const permissions = await import("../src/permissions.mjs");
const published = await import("../src/published.mjs");
const inbound = await import("../src/inbound.mjs");
const outbox = await import("../src/outbox.mjs");
const remote = await import("../src/remote.mjs");
const gateway = await import("../src/gateway.mjs");
const relay = await import("../src/relay.mjs");
const relaylink = await import("../src/relaylink.mjs");
const wsframe = await import("../src/wsframe.mjs");
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
const SESSION = { vendor: "cursor", id: "conv-bob-relay", name: "reviewer" };
as(BOB, () => register({ ...SESSION, cwd: "/work/web-app" }));

const running = await relay.serve({ port: 0, host: "127.0.0.1" });
const children = [];
after(() => {
  for (const c of children) c.kill();
  return running.close();
});
const RELAY_URL = running.url;

// The two people join one project, and neither one has a direct address.
const offer = as(ALICE, () => invite.create({ label: "web-app" }));
const taken = as(BOB, () => invite.accept(offer.token, offer.fingerprint));
as(ALICE, () => invite.accept(taken.reply.token, taken.mine));
const PROJECT = offer.project.id;
as(BOB, () => published.publish(PROJECT, SESSION));
as(BOB, () => permissions.set(PROJECT, alice.ownerId, "accept"));

const peerOf = (home, owner) => as(home, () => directory.member(PROJECT, owner));

// The gateway of Bob, in its own process. It connects to the relay, and it
// writes what an agent would read.
function startBob() {
  const script = path.join(BOB, `gateway-${Date.now()}.mjs`);
  fs.writeFileSync(
    script,
    `import fs from "node:fs";
     const gateway = await import(${JSON.stringify(path.join(ROOT, "src/gateway.mjs"))});
     await gateway.joinRelay(process.env.RELAY_URL, {
       log: (line) => console.log("bob:", line),
       deliver: async (agent, message, { text }) => {
         fs.appendFileSync(process.env.STUB_OUT, JSON.stringify({ agent: agent.id, text }) + "\\n");
         return { delivered: true, transport: "stub" };
       },
     });
     console.log("ready");
    `,
  );
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, OPENMSG_HOME: BOB, OPENMSG_RELAY_HOME: RELAY_HOME, RELAY_URL, STUB_OUT },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const ready = new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`bob did not start: ${out}`)), 10_000);
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes("connected as")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (d) => (out += d));
  });
  return { child, ready };
}

function stubLines() {
  try {
    return fs.readFileSync(STUB_OUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

async function aliceSends(text, routingRows = null) {
  return asAsync(ALICE, async () => {
    const receipts = [];
    const link = await relaylink.open(RELAY_URL, { onReceipt: (f) => receipts.push(f) });
    let rows = routingRows;
    if (!rows) {
      try {
        rows = (await gateway.routingOverRelay(link, peerOf(ALICE, bob.ownerId), PROJECT)).routing;
      } catch {
        rows = directory.routingOf(PROJECT, bob.ownerId)?.rows ?? [];
      }
    }
    const row = rows[0];
    const message = remote.createRemote({
      from: { owner: alice.ownerId, vendor: "claude", id: "ses_alice", name: "api-worker" },
      project: { id: PROJECT, label: "web-app" },
      target: { owner: bob.ownerId, project: PROJECT, session: row.session, epoch: row.epoch },
      text,
    });
    const wire = remote.pack(message, { recipient: peerOf(ALICE, bob.ownerId) });
    outbox.put({ messageId: message.messageId, to: bob.ownerId, project: PROJECT, wire, state: "sending" });
    const answer = await link.send(wire);
    if (answer.type === "stored") outbox.setState(message.messageId, "queued");
    return { messageId: message.messageId, wire, answer, receipts, link };
  });
}

test("a hello with a key that does not give the owner id is refused", async () => {
  const connection = await wsframe.connect(RELAY_URL);
  const answers = [];
  connection.on("message", (t) => answers.push(JSON.parse(t)));
  connection.send(JSON.stringify({ type: "hello", version: 2, owner: "o_00000000", keys: alice.keys, at: new Date().toISOString() }));
  await sleep(200);
  assert.equal(answers[0]?.type, "error");
  assert.match(answers[0].error, /does not prove/);
});

test("the relay holds a sealed message for a receiver that is offline", async () => {
  // Bob ran one time, so Alice holds routing data. Bob is offline now.
  const first = startBob();
  await first.ready;
  await asAsync(ALICE, async () => {
    const link = await relaylink.open(RELAY_URL);
    await gateway.routingOverRelay(link, peerOf(ALICE, bob.ownerId), PROJECT);
    link.close();
  });
  first.child.kill();
  await sleep(300);

  const sent = await aliceSends("Bob was offline when this left.");
  assert.equal(sent.answer.type, "stored");
  sent.link.close();
  assert.equal(stubLines().length, 0, "no agent read it yet");

  const waiting = relay.queued(bob.ownerId);
  assert.equal(waiting.length, 1);
  // The relay holds bytes that it cannot read.
  const onDisk = fs.readFileSync(waiting[0].file, "utf8");
  assert.ok(!onDisk.includes("Bob was offline"), "the store holds no readable text");
  assert.ok(!onDisk.includes("conv-bob-relay"), "the store holds no session id");
  assert.match(onDisk, /"seal"/);

  // Bob starts, and the message arrives.
  const second = startBob();
  await second.ready;
  await sleep(800);
  const read = stubLines();
  assert.equal(read.length, 1, "the message arrives one time");
  assert.match(read[0].text, /Bob was offline when this left./);
  assert.equal(relay.queued(bob.ownerId).length, 0, "the relay forgets it after the acknowledgement");
});

test("the sender keeps the message until a receipt says that it arrived", async () => {
  const rows = as(ALICE, () => directory.routingOf(PROJECT, bob.ownerId).rows);
  const sent = await aliceSends("A message with a receipt.", rows);
  assert.equal(sent.answer.type, "stored");
  await sleep(700);
  sent.link.close();
  const receipt = sent.receipts.find((r) => r.messageId === sent.messageId);
  assert.ok(receipt, "a receipt came back");
  assert.equal(receipt.status, "adapter-accepted");
  as(ALICE, () => outbox.setState(sent.messageId, receipt.status));
  assert.equal(as(ALICE, () => outbox.find(sent.messageId)).state, "adapter-accepted");
  assert.ok(
    !as(ALICE, () => outbox.waiting()).some((r) => r.messageId === sent.messageId),
    "this message waits no more",
  );
});

test("a receipt for a sender that was offline waits at the relay", async () => {
  // Nobody is online: Alice sends, and she leaves before Bob answers.
  for (const c of children) c.kill();
  await sleep(300);
  const rows = as(ALICE, () => directory.routingOf(PROJECT, bob.ownerId).rows);
  const sent = await aliceSends("A receipt with nobody to take it.", rows);
  assert.equal(sent.answer.type, "stored");
  sent.link.close();
  await sleep(200);

  // Bob takes the message, and he acknowledges it while Alice is away.
  const bobAgain = startBob();
  await bobAgain.ready;
  await sleep(700);
  assert.equal(relay.queued(bob.ownerId).length, 0, "the relay forgot it after the acknowledgement");
  assert.equal(relay.receipts(alice.ownerId).length, 1, "the relay keeps the receipt for Alice");

  // Alice comes back, and the receipt arrives with the welcome.
  const late = [];
  const link = await asAsync(ALICE, () => relaylink.open(RELAY_URL, { onReceipt: (f) => late.push(f) }));
  await sleep(300);
  link.close();
  const mine = late.find((r) => r.messageId === sent.messageId);
  assert.ok(mine, "the relay gave the receipt that it kept");
  assert.equal(mine.status, "adapter-accepted");
  assert.equal(relay.receipts(alice.ownerId).length, 0, "the relay keeps it no longer");
  as(ALICE, () => outbox.setState(sent.messageId, mine.status));
});

test("one message arrives one time, also when the sender sends it again", async () => {
  const rows = as(ALICE, () => directory.routingOf(PROJECT, bob.ownerId).rows);
  const before = stubLines().length;
  const sent = await aliceSends("Say this one time.", rows);
  await sleep(600);
  // The same sealed bytes again, as a retry after a network fault.
  const again = await asAsync(ALICE, async () => {
    const link = await relaylink.open(RELAY_URL);
    const answer = await link.send(sent.wire);
    link.close();
    return answer;
  });
  await sleep(600);
  sent.link.close();
  assert.equal(stubLines().length, before + 1, "the agent read it one time");
  assert.equal(again.type, "stored", "the relay takes the retry");
  const rows2 = as(BOB, () => inbound.list().filter((r) => r.messageId === sent.messageId));
  assert.equal(rows2.at(-1).reason, "duplicate", "the receiver knows the second copy");
});

test("the relay refuses a message that names another sender, and one that is too big", async () => {
  await asAsync(ALICE, async () => {
    const link = await relaylink.open(RELAY_URL);
    const rows = directory.routingOf(PROJECT, bob.ownerId).rows;
    const message = remote.createRemote({
      from: { owner: alice.ownerId, vendor: "claude", id: "ses_alice", name: "api-worker" },
      project: { id: PROJECT, label: "web-app" },
      target: { owner: bob.ownerId, project: PROJECT, session: rows[0].session, epoch: rows[0].epoch },
      text: "who am i",
    });
    const wire = remote.pack(message, { recipient: peerOf(ALICE, bob.ownerId) });
    const lie = await link.send({ ...wire, from: { owner: "o_12345678" } });
    assert.equal(lie.type, "refused");
    assert.equal(lie.reason, "sender-mismatch");

    const big = await link.send({ ...wire, seal: { ...wire.seal, ct: "A".repeat(relay.LIMITS.messageBytes + 10) } });
    assert.equal(big.type, "refused");
    assert.equal(big.reason, "too-big");
    link.close();
  });
});

test("the relay drops a message that passed its deadline", async () => {
  const old = {
    kind: "sealed",
    version: 2,
    messageId: "expired-one",
    createdAt: new Date(Date.now() - 7200_000).toISOString(),
    expiresAt: new Date(Date.now() - 3600_000).toISOString(),
    from: { owner: alice.ownerId },
    project: { id: PROJECT },
    target: { owner: bob.ownerId, project: PROJECT },
    seal: { alg: "x", epk: "x", iv: "x", ct: "x" },
  };
  const answer = await asAsync(ALICE, async () => {
    const link = await relaylink.open(RELAY_URL);
    const out = await link.send(old);
    link.close();
    return out;
  });
  assert.equal(answer.type, "refused");
  assert.equal(answer.reason, "expired");
});
