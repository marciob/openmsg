// The acceptance demonstration of section 11 of the spec: fourteen cases.
//
// Two owners with their own homes, one relay, and a gateway in its own
// process for the cases that need a real connection and a real crash. The
// other cases call the gateway inside this process, over the same code.
//
// Case 3 also passed with a live Claude session that was busy, on 2026-09-19
// and 2026-09-20. A stub adapter cannot show a model at work, so the test
// here shows what the code promises: delivery does not wait for a session to
// become idle, and two messages that arrive together each arrive one time.
// Run: node --test
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const ALICE = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-xa-"));
const BOB = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-xb-"));
const RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-xr-"));
const READ_BY_BOB = path.join(BOB, "agent-read.txt");
process.env.OPENMSG_RELAY_HOME = RELAY_HOME;

const identity = await import("../src/identity.mjs");
const directory = await import("../src/directory.mjs");
const invite = await import("../src/invite.mjs");
const permissions = await import("../src/permissions.mjs");
const published = await import("../src/published.mjs");
const inbound = await import("../src/inbound.mjs");
const remote = await import("../src/remote.mjs");
const gateway = await import("../src/gateway.mjs");
const relay = await import("../src/relay.mjs");
const relaylink = await import("../src/relaylink.mjs");
const seal = await import("../src/seal.mjs");
const { canonicalBytes } = await import("../src/canonical.mjs");
const { MAX_HOPS } = await import("../src/envelope.mjs");
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

// --- the two owners, and one relay ----------------------------------------

const alice = as(ALICE, () => identity.create({ label: "alice" }));
const bob = as(BOB, () => identity.create({ label: "bob" }));
const BOB_SESSION = { vendor: "cursor", id: "conv-bob-1", name: "reviewer" };
const ALICE_SESSION = { vendor: "cursor", id: "conv-alice-1", name: "builder" };
as(BOB, () => register({ ...BOB_SESSION, cwd: "/work" }));
as(ALICE, () => register({ ...ALICE_SESSION, cwd: "/work" }));
// The limits have their own tests. This demonstration sends more messages
// than a person does in five minutes, so it raises them.
for (const home of [ALICE, BOB]) {
  fs.writeFileSync(path.join(home, "limits.json"), JSON.stringify({ senderPerWindow: 500, turnsPerSession: 500 }));
}

const running = await relay.serve({ port: 0, host: "127.0.0.1" });
const children = [];
after(() => {
  for (const c of children) c.kill();
  return running.close();
});

let readByBob = [];
const stub = async (agent, message, { text }) => {
  readByBob.push(text);
  return { delivered: true, transport: "stub" };
};
const bobReads = () => {
  try {
    return fs.readFileSync(READ_BY_BOB, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

let PROJECT = null;
const peer = (home, owner) => as(home, () => directory.member(PROJECT, owner));

function letterToBob(text, { messageId = null, epoch = 1, session = BOB_SESSION.id, hops = [], expiresAt = null } = {}) {
  return as(ALICE, () => {
    const message = remote.createRemote({
      from: { owner: alice.ownerId, vendor: "claude", id: "ses_alice", name: "api-worker" },
      project: { id: PROJECT, label: "web-app" },
      target: { owner: bob.ownerId, project: PROJECT, session, epoch },
      text,
      hops,
      expiresAt,
    });
    if (messageId) message.messageId = messageId;
    return remote.pack(message, { recipient: peer(ALICE, bob.ownerId) });
  });
}
const bobReceives = (wire, options = {}) => asAsync(BOB, () => gateway.receive(wire, { deliver: stub, ...options }));

// The gateway of Bob, in its own process, on the relay.
function startBob({ crashAfterDelivery = false } = {}) {
  const script = path.join(BOB, `gateway-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
  fs.writeFileSync(
    script,
    `import fs from "node:fs";
     const gateway = await import(${JSON.stringify(path.join(ROOT, "src/gateway.mjs"))});
     await gateway.joinRelay(process.env.RELAY_URL, {
       log: (line) => console.log("bob:", line),
       deliver: async (agent, message, { text }) => {
         fs.appendFileSync(process.env.READ_BY_BOB, text.replace(/\\n/g, " ") + "\\n");
         ${crashAfterDelivery ? "process.exit(9);" : ""}
         return { delivered: true, transport: "stub" };
       },
     });
     console.log("ready");`,
  );
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, OPENMSG_HOME: BOB, OPENMSG_RELAY_HOME: RELAY_HOME, RELAY_URL: running.url, READ_BY_BOB },
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
  return { child, ready, gone: new Promise((r) => child.on("exit", r)) };
}

// --- the fourteen cases ----------------------------------------------------

test("1. two owners, one project, one session published by each side", async () => {
  const offer = as(ALICE, () => invite.create({ label: "web-app" }));
  const taken = as(BOB, () => invite.accept(offer.token, offer.fingerprint));
  as(ALICE, () => invite.accept(taken.reply.token, taken.mine));
  PROJECT = offer.project.id;

  for (const [home, mine, theirs] of [[ALICE, alice, bob], [BOB, bob, alice]]) {
    const members = as(home, () => directory.members(PROJECT));
    assert.deepEqual(members.map((m) => m.ownerId).sort(), [mine.ownerId, theirs.ownerId].sort());
  }
  as(BOB, () => published.publish(PROJECT, BOB_SESSION));
  as(ALICE, () => published.publish(PROJECT, ALICE_SESSION));
  assert.equal(as(BOB, () => published.list(PROJECT)).length, 1);
  assert.equal(as(ALICE, () => published.list(PROJECT)).length, 1);

  const { presence, routing } = await asAsync(BOB, () => gateway.descriptions(PROJECT));
  assert.equal(presence[0].alias, "cursor:reviewer@bob");
  assert.equal(routing[0].session, BOB_SESSION.id);
});

test("2. an invitation, verified by fingerprint, before the first message", () => {
  const stranger = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-xs-"));
  const mallory = as(stranger, () => identity.create({ label: "mallory" }));
  const offer = as(BOB, () => invite.create({ label: "web-app", projectId: PROJECT }));
  // A fingerprint that does not match stops the invitation.
  assert.throws(() => as(stranger, () => invite.accept(offer.token, "0000 0000 0000 0000 0000 0000 0000 0000")), /does not match/);
  assert.equal(as(stranger, () => directory.member(PROJECT, bob.ownerId)), null);
  // And a message from that person, whom nobody accepted, is refused.
  const wire = as(stranger, () => {
    directory.put({ id: PROJECT, label: "web-app" }, bob);
    const message = remote.createRemote({
      from: { owner: mallory.ownerId, vendor: "claude", id: "s", name: "m" },
      project: { id: PROJECT, label: "web-app" },
      target: { owner: bob.ownerId, project: PROJECT, session: BOB_SESSION.id, epoch: 1 },
      text: "let me in",
    });
    return remote.pack(message, { recipient: { ownerId: bob.ownerId, keys: bob.keys } });
  });
  return bobReceives(wire).then((out) => {
    assert.equal(out.status, "refused");
    assert.equal(out.reason, "unknown-sender");
    assert.equal(readByBob.length, 0);
  });
});

test("9. a sender that the owner has not accepted stays held, outside the model", async () => {
  // The default permission is hold, also for a person in the directory.
  assert.equal(as(BOB, () => permissions.of(PROJECT, alice.ownerId)), "hold");
  const out = await bobReceives(letterToBob("the first message of alice"));
  assert.equal(out.status, "held");
  assert.equal(readByBob.length, 0, "no model read it");
  const held = as(BOB, () => inbound.list({ status: "held" }));
  assert.equal(held.length, 1);
  assert.equal(held[0].from.label, "alice");

  // The owner accepts the sender, and then the message reaches the agent.
  as(BOB, () => permissions.set(PROJECT, alice.ownerId, "accept"));
  const released = await asAsync(BOB, () => gateway.release(held[0], { deliver: stub }));
  assert.equal(released.status, "adapter-accepted");
  assert.equal(readByBob.length, 1);
});

test("3. a message that arrives while the receiving agent is busy", async () => {
  // The adapter of a busy session takes time. Two messages arrive together,
  // and each one arrives one time.
  const slow = async (agent, message, { text }) => {
    await sleep(150);
    readByBob.push(text);
    return { delivered: true, transport: "stub" };
  };
  readByBob = [];
  const [one, two] = await Promise.all([
    bobReceives(letterToBob("while busy, one"), { deliver: slow }),
    bobReceives(letterToBob("while busy, two"), { deliver: slow }),
  ]);
  assert.equal(one.status, "adapter-accepted");
  assert.equal(two.status, "adapter-accepted");
  assert.equal(readByBob.length, 2);
  assert.equal(readByBob.filter((t) => t.includes("while busy, one")).length, 1);
});

test("10. a message with a changed byte, refused by the signature", async () => {
  const wire = letterToBob("the true text");
  const flip = (s) => s.slice(0, -2) + (s.endsWith("AA") ? "BB" : "AA");
  readByBob = [];
  const out = await bobReceives({ ...wire, seal: { ...wire.seal, ct: flip(wire.seal.ct) } });
  assert.equal(out.status, "refused");
  assert.equal(out.reason, "unseal-failed");

  // And a byte that changes inside the signed envelope, under a seal that the
  // attacker made, fails on the signature.
  const forged = as(ALICE, () => {
    const signed = remote.sign(
      remote.createRemote({
        from: { owner: alice.ownerId, vendor: "claude", id: "ses_alice", name: "api-worker" },
        project: { id: PROJECT, label: "web-app" },
        target: { owner: bob.ownerId, project: PROJECT, session: BOB_SESSION.id, epoch: 1 },
        text: "the true text",
      }),
    );
    signed.parts[0].text = "another text";
    const header = remote.clearHeaderOf(signed);
    return { ...header, seal: seal.seal(canonicalBytes(signed), bob.keys.encryption, canonicalBytes(header)) };
  });
  const second = await bobReceives(forged);
  assert.equal(second.reason, "bad-signature");
  assert.equal(readByBob.length, 0);
});

test("12. two messages with one messageId and different content", async () => {
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  readByBob = [];
  assert.equal((await bobReceives(letterToBob("the true text", { messageId: id }))).status, "adapter-accepted");
  const second = await bobReceives(letterToBob("another text", { messageId: id }));
  assert.equal(second.status, "refused");
  assert.equal(second.reason, "conflict");
  assert.equal(readByBob.length, 1, "the second content never reached the agent");
  const row = as(BOB, () => inbound.find(id));
  assert.match(row.message.parts[0].text, /the true text/, "the record of the first message holds");
});

test("5. a retry with the same messageId does not deliver a second copy", async () => {
  readByBob = [];
  const wire = letterToBob("say this one time");
  assert.equal((await bobReceives(wire)).status, "adapter-accepted");
  const again = await bobReceives(wire);
  assert.equal(again.reason, "duplicate");
  assert.equal(readByBob.length, 1);
});

test("7. a message for a session that restarted, refused by the epoch", async () => {
  readByBob = [];
  // The alias moves to a new session, and then back to a session that took
  // the old id again. The epoch counts each move.
  as(BOB, () => published.publish(PROJECT, { vendor: "cursor", id: "conv-bob-2", name: "reviewer" }));
  const third = as(BOB, () => published.publish(PROJECT, BOB_SESSION));
  assert.equal(third.epoch, 3, "a new session under one name is a new epoch");
  const out = await bobReceives(letterToBob("for the session that ended", { epoch: 1 }));
  assert.equal(out.status, "refused");
  assert.equal(out.reason, "old-epoch");
  assert.equal(readByBob.length, 0);
});

test("8. a limit on replies stops a loop between two people", async () => {
  readByBob = [];
  const long = Array.from({ length: MAX_HOPS - 1 }, (_, i) => `claude:a${i}@o_1111111${i}`);
  // The sender refuses to make a message that passes the limit.
  assert.throws(() => letterToBob("too far", { hops: Array.from({ length: MAX_HOPS }, (_, i) => `claude:b${i}@o_2222222${i}`) }),
    (e) => e.reason === "hop-limit");

  // A sender that does not follow the rule is refused by the receiver.
  const wire = as(ALICE, () => {
    const message = remote.createRemote({
      from: { owner: alice.ownerId, vendor: "claude", id: "ses_alice", name: "api-worker" },
      project: { id: PROJECT, label: "web-app" },
      target: { owner: bob.ownerId, project: PROJECT, session: BOB_SESSION.id, epoch: 3 },
      text: "a loop without end",
      hops: long,
    });
    message.openmsg.hops = [...message.openmsg.hops, "claude:extra@o_33333333", "claude:more@o_44444444"];
    const signed = remote.sign(message);
    const header = remote.clearHeaderOf(signed);
    return { ...header, seal: seal.seal(canonicalBytes(signed), bob.keys.encryption, canonicalBytes(header)) };
  });
  const out = await bobReceives(wire);
  assert.equal(out.status, "refused");
  assert.equal(out.reason, "hop-limit");
  assert.equal(readByBob.length, 0);
});

test("11. a message that expires while it waits never reaches the model", async () => {
  readByBob = [];
  // It arrives, the owner does not accept it yet, and the deadline passes.
  as(BOB, () => permissions.set(PROJECT, alice.ownerId, "hold"));
  const wire = letterToBob("read me today", { epoch: 3, expiresAt: new Date(Date.now() + 1000).toISOString() });
  const out = await bobReceives(wire);
  assert.equal(out.status, "held");
  const held = as(BOB, () => inbound.find(wire.messageId));

  const later = Date.now() + 5000;
  const released = await asAsync(BOB, () => gateway.release(held, { deliver: stub, now: later }));
  assert.equal(released.status, "expired");
  assert.equal(readByBob.length, 0, "no model read it");
  assert.equal(as(BOB, () => inbound.find(wire.messageId)).status, "expired");

  // And a message that arrives after its deadline never starts.
  const dead = letterToBob("too late", { epoch: 3, expiresAt: new Date(Date.now() - 1000).toISOString() });
  const second = await bobReceives(dead);
  assert.equal(second.status, "refused");
  assert.equal(second.reason, "expired");
  as(BOB, () => permissions.set(PROJECT, alice.ownerId, "accept"));
});

test("6. a sender whose key was revoked is refused", async () => {
  readByBob = [];
  const wire = letterToBob("after the revocation", { epoch: 3 });
  as(BOB, () => directory.revoke(PROJECT, alice.ownerId, "a laptop that somebody took"));
  const out = await bobReceives(wire);
  assert.equal(out.status, "refused");
  assert.equal(out.reason, "revoked-sender");
  assert.equal(readByBob.length, 0);
  // The directory of Bob holds Alice again for the cases that follow.
  as(BOB, () => {
    const data = directory.read();
    data.projects[PROJECT].revoked = [];
    fs.writeFileSync(path.join(BOB, "directory.json"), JSON.stringify(data));
  });
});

test("4. a receiver that is offline gets the message after it reconnects", async () => {
  // Bob runs one time, so Alice holds routing data. Then Bob stops.
  const first = startBob();
  await first.ready;
  await asAsync(ALICE, async () => {
    const link = await relaylink.open(running.url);
    await gateway.routingOverRelay(link, peer(ALICE, bob.ownerId), PROJECT);
    link.close();
  });
  first.child.kill();
  await first.gone;

  const wire = letterToBob("Bob was offline when this left", { epoch: 3 });
  const answer = await asAsync(ALICE, async () => {
    const link = await relaylink.open(running.url);
    const out = await link.send(wire);
    link.close();
    return out;
  });
  assert.equal(answer.type, "stored");
  assert.equal(bobReads().length, 0);
  assert.equal(relay.queued(bob.ownerId).length, 1);

  const second = startBob();
  await second.ready;
  await sleep(700);
  const read = bobReads();
  assert.equal(read.length, 1, "it arrives one time");
  assert.match(read[0], /Bob was offline when this left/);
  assert.equal(relay.queued(bob.ownerId).length, 0);
  second.child.kill();
  await second.gone;
});

test("13. a key revoked after the message entered the queue", async () => {
  const before = bobReads().length;
  const wire = letterToBob("sent before the revocation", { epoch: 3 });
  await asAsync(ALICE, async () => {
    const link = await relaylink.open(running.url);
    const out = await link.send(wire);
    link.close();
    assert.equal(out.type, "stored");
  });
  // The message waits at the relay, and the team revokes the key now.
  as(BOB, () => directory.revoke(PROJECT, alice.ownerId, "revoked while the message waited"));

  const gate = startBob();
  await gate.ready;
  await sleep(700);
  assert.equal(bobReads().length, before, "no model read it");
  const row = as(BOB, () => inbound.find(wire.messageId));
  assert.equal(row.status, "refused");
  assert.equal(row.reason, "revoked-sender");
  assert.equal(relay.queued(bob.ownerId).length, 0, "a refusal also tells the relay to forget the message");
  gate.child.kill();
  await gate.gone;
  as(BOB, () => {
    const data = directory.read();
    data.projects[PROJECT].revoked = [];
    fs.writeFileSync(path.join(BOB, "directory.json"), JSON.stringify(data));
  });
});

test("14. a crash between the injection and the acknowledgement, and the receiver says so", async () => {
  const before = bobReads().length;
  const wire = letterToBob("the gateway stops after the injection", { epoch: 3 });
  await asAsync(ALICE, async () => {
    const link = await relaylink.open(running.url);
    assert.equal((await link.send(wire)).type, "stored");
    link.close();
  });

  // The gateway gives the message to the adapter, and it stops before it
  // acknowledges. Nobody knows whether the model read the message.
  const crashing = startBob({ crashAfterDelivery: true });
  await crashing.ready;
  const code = await crashing.gone;
  assert.equal(code, 9, "the gateway stopped after the injection");
  assert.equal(bobReads().length, before + 1, "the adapter took it one time");

  // The state stays ambiguous, and the receiver says so in words.
  const row = as(BOB, () => inbound.find(wire.messageId));
  assert.equal(row.status, "queued");
  assert.equal(row.reason, "delivering");
  assert.ok(row.deliveryStartedAt, "the store holds the moment of the injection");
  assert.match(inbound.EXPLAIN.queued, /nobody knows whether the adapter took it/);
  // The relay kept the message, because no acknowledgement arrived.
  assert.equal(relay.queued(bob.ownerId).length, 1);

  // The gateway starts again, and the relay sends the message again. The
  // receiver gives it to the agent one more time, because a message that
  // arrives twice is better than a message that nobody sees. Rule 8.7 of the
  // spec says that the agent must expect a repeat.
  const again = startBob();
  await again.ready;
  await sleep(700);
  assert.equal(bobReads().length, before + 2, "the message arrives again after the doubt");
  const after2 = as(BOB, () => inbound.find(wire.messageId));
  assert.equal(after2.status, "adapter-accepted");
  assert.equal(relay.queued(bob.ownerId).length, 0, "the relay forgets it after the acknowledgement");
  again.child.kill();
  await again.gone;
});
