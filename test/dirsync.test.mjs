// Tests for the directory on the relay, from section 12.1 of the spec.
//
// A record is signed by its owner, and it carries the public keys of that
// owner. The owner id comes from those keys, so a record proves itself and
// the relay needs no directory of its own.
// Run: node --test
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DESK = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-yd-"));
const LAPTOP = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-yl-"));
const BOB = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-yb-"));
const RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-yr-"));
process.env.OPENMSG_RELAY_HOME = RELAY_HOME;

const identity = await import("../src/identity.mjs");
const device = await import("../src/device.mjs");
const directory = await import("../src/directory.mjs");
const invite = await import("../src/invite.mjs");
const dirsync = await import("../src/dirsync.mjs");
const gateway = await import("../src/gateway.mjs");
const relay = await import("../src/relay.mjs");
const relaylink = await import("../src/relaylink.mjs");
const { saveSettings } = await import("../src/settings.mjs");

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

const alice = as(DESK, () => identity.create({ label: "alice" }));
const bob = as(BOB, () => identity.create({ label: "bob" }));
const running = await relay.serve({ port: 0, host: "127.0.0.1" });
after(() => running.close());
for (const home of [DESK, LAPTOP, BOB]) as(home, () => saveSettings({ relay: running.url }));

const offer = as(DESK, () => invite.create({ label: "web-app", endpoint: "http://127.0.0.1:7001" }));
const taken = as(BOB, () => invite.accept(offer.token, offer.fingerprint, { endpoint: "http://127.0.0.1:7002" }));
as(DESK, () => invite.accept(taken.reply.token, taken.mine));
const PROJECT = offer.project.id;

// The second machine of Alice: the public record of the owner and its own
// keys. It holds no directory at all.
fs.mkdirSync(path.join(LAPTOP, "keys"), { recursive: true });
fs.copyFileSync(path.join(DESK, "keys", "identity.json"), path.join(LAPTOP, "keys", "identity.json"));
const laptop = as(LAPTOP, () => device.create({ label: "laptop" }));
const grant = as(DESK, () => device.grant(device.readRequest(as(LAPTOP, () => device.request())), { projects: "all" }));
as(LAPTOP, () => device.saveDelegation(grant.record));
as(LAPTOP, () => directory.put({ id: PROJECT, label: "web-app" }, alice, { source: "self" }));

const sync = (home) =>
  asAsync(home, async () => {
    const link = await relaylink.open(running.url);
    const rows = await gateway.syncDirectory(link);
    link.close();
    return rows;
  });

test("a record proves itself, and a changed byte breaks it", () => {
  const record = as(DESK, () => dirsync.selfRecord(PROJECT));
  assert.equal(dirsync.verifyRecord(record), null);
  assert.equal(record.owner, alice.ownerId);
  assert.match(dirsync.verifyRecord({ ...record, label: "somebody else" }), /does not match/);
  assert.match(dirsync.verifyRecord({ ...record, owner: bob.ownerId }), /claims an owner/);
  assert.match(dirsync.verifyRecord({ ...record, kind: "nonsense" }), /unknown record/);
});

test("the relay takes a record from its owner, and from nobody else", async () => {
  await asAsync(DESK, async () => {
    const link = await relaylink.open(running.url);
    const mine = await link.publishRecord(dirsync.selfRecord(PROJECT));
    assert.equal(mine.type, "dir-stored");
    // A record of another owner, on this connection, is refused.
    const theirs = as(BOB, () => dirsync.selfRecord(PROJECT));
    const no = await link.publishRecord(theirs);
    assert.equal(no.type, "dir-refused");
    assert.equal(no.reason, "sender-mismatch");
    link.close();
  });
  assert.equal(relay.records(PROJECT).length, 1);
});

test("a person outside the project reads nothing", async () => {
  const stranger = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-yx-"));
  as(stranger, () => identity.create({ label: "mallory" }));
  await asAsync(stranger, async () => {
    const link = await relaylink.open(running.url);
    const got = await link.fetchDirectory(PROJECT);
    assert.deepEqual(got.records, []);
    assert.match(got.error, /no record in that project/);
    link.close();
  });
});

test("the second machine of one owner learns the whole directory", async () => {
  // The laptop knows nobody but its owner.
  assert.equal(as(LAPTOP, () => directory.member(PROJECT, bob.ownerId)), null);

  await sync(DESK);
  const rows = await sync(LAPTOP);
  const applied = rows.find((r) => r.project === PROJECT);
  assert.equal(applied.added.length, 1);
  assert.equal(applied.added[0].owner, bob.ownerId);

  const known = as(LAPTOP, () => directory.member(PROJECT, bob.ownerId));
  assert.ok(known, "the laptop holds Bob now");
  assert.equal(known.fingerprint, identity.fingerprint(bob), "with the fingerprint that Alice compared");
  assert.equal(known.endpoint, "http://127.0.0.1:7002", "and the address of his gateway");
  assert.deepEqual(known.keys, bob.keys);
});

test("the roster of another person adds nobody", async () => {
  // Bob holds no record of Carol. Alice writes a roster that names Carol,
  // and the roster of another person never adds a member.
  const carolHome = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-yc-"));
  const carol = as(carolHome, () => identity.create({ label: "carol" }));
  as(DESK, () => directory.put({ id: PROJECT, label: "web-app" }, carol, { source: "invite" }));
  await sync(DESK);
  const rows = await sync(BOB);
  const applied = rows.find((r) => r.project === PROJECT);
  assert.equal(applied.added.length, 0, "Bob adds nobody from the roster of Alice");
  assert.equal(as(BOB, () => directory.member(PROJECT, carol.ownerId)), null);

  // Carol says who she is, and Bob sees her waiting, with her fingerprint.
  as(carolHome, () => {
    saveSettings({ relay: running.url });
    directory.put({ id: PROJECT, label: "web-app" }, alice, { source: "self" });
  });
  await sync(carolHome);
  const second = await sync(BOB);
  const waiting = second.find((r) => r.project === PROJECT).pending;
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].ownerId, carol.ownerId);
  assert.equal(waiting[0].fingerprint, identity.fingerprint(carol));
  assert.equal(as(BOB, () => directory.member(PROJECT, carol.ownerId)), null, "waiting is not a member");

  // The person compares the fingerprint, and then she is a member.
  assert.throws(() => as(BOB, () => dirsync.acceptPending(PROJECT, carol.ownerId, "0000 0000 0000 0000 0000 0000 0000 0000")),
    /does not match/);
  as(BOB, () => dirsync.acceptPending(PROJECT, carol.ownerId, identity.fingerprint(carol)));
  assert.ok(as(BOB, () => directory.member(PROJECT, carol.ownerId)));
  assert.equal(as(BOB, () => directory.pending(PROJECT)).length, 0);
});

test("an owner tells the team that a machine of theirs is gone", async () => {
  assert.equal(as(BOB, () => directory.isDeviceRevoked(PROJECT, laptop.deviceId)), false);
  // Alice revokes her own machine, and the record says so.
  as(DESK, () => directory.revokeDevice(PROJECT, laptop.deviceId, "the laptop was stolen", { owner: alice.ownerId }));
  await sync(DESK);
  await sync(BOB);
  assert.equal(as(BOB, () => directory.isDeviceRevoked(PROJECT, laptop.deviceId)), true);
  const row = as(BOB, () => directory.revokedDevices(PROJECT))[0];
  assert.equal(row.owner, alice.ownerId);
  assert.match(row.reason, /stolen/);
});
