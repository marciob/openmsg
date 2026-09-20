// Tests for the identity, the invitation, and the directory of version 0.2.
// They need no account and no network. Two homes stand for two people.
// Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ALICE = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-alice-"));
const BOB = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-bob-"));

const { canonical } = await import("../src/canonical.mjs");
const identity = await import("../src/identity.mjs");
const directory = await import("../src/directory.mjs");
const invite = await import("../src/invite.mjs");

// Every module reads OPENMSG_HOME at the moment of the call, so one process
// works as two people.
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

const alice = as(ALICE, () => identity.create({ label: "alice" }));
const bob = as(BOB, () => identity.create({ label: "bob" }));

test("the canonical form writes one text for one object", () => {
  assert.equal(canonical({ b: 1, a: [2, { d: null, c: "x" }] }), '{"a":[2,{"c":"x","d":null}],"b":1}');
  assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }));
  assert.equal(canonical({ a: 1, gone: undefined }), '{"a":1}');
});

test("an identity holds two keys, and the private keys stay closed", () => {
  const p = as(ALICE, () => identity.paths());
  assert.equal(fs.statSync(p.signing).mode & 0o777, 0o600);
  assert.equal(fs.statSync(p.encryption).mode & 0o777, 0o600);
  assert.equal(alice.keys.signing.alg, "Ed25519");
  assert.equal(alice.keys.encryption.alg, "X25519");
  assert.match(alice.ownerId, /^o_[0-9a-f]{8}$/);
  assert.match(identity.fingerprint(alice), /^([0-9A-F]{4} ){7}[0-9A-F]{4}$/);
  assert.notEqual(alice.ownerId, bob.ownerId);
  assert.deepEqual(as(ALICE, () => identity.load()), alice, "the record reads back");
});

test("a record that claims an owner id which its keys do not give is refused", () => {
  assert.throws(() => identity.checkRecord({ ...alice, ownerId: "o_00000000" }), /claims the owner/);
  const swapped = { ...alice, keys: { ...alice.keys, signing: bob.keys.signing } };
  assert.throws(() => identity.checkRecord(swapped), /claims the owner/);
});

test("a second identity does not replace the first one without force", () => {
  assert.throws(() => as(ALICE, () => identity.create({ label: "other" })), /cannot open what the old key sealed/);
  assert.deepEqual(as(ALICE, () => identity.load()), alice);
});

test("an invitation and its answer put the two people in both directories", () => {
  const offer = as(ALICE, () => invite.create({ label: "web-app" }));
  const taken = as(BOB, () => invite.accept(offer.token, offer.fingerprint));
  assert.equal(taken.peer.ownerId, alice.ownerId);
  as(ALICE, () => invite.accept(taken.reply.token, taken.mine));

  for (const [home, mine, theirs] of [[ALICE, alice, bob], [BOB, bob, alice]]) {
    const seen = as(home, () => directory.members(offer.project.id));
    assert.deepEqual(seen.map((m) => m.ownerId).sort(), [mine.ownerId, theirs.ownerId].sort());
    const peer = as(home, () => directory.member(offer.project.id, theirs.ownerId));
    assert.equal(peer.fingerprint, identity.fingerprint(theirs), "each home shows the fingerprint of the other");
    assert.deepEqual(peer.keys, theirs.keys);
  }
  assert.equal(taken.reply.body.type, "accept");
  const answer = as(ALICE, () => invite.accept(taken.reply.token, taken.mine));
  assert.equal(answer.reply, null, "an answer starts no third token");
});

test("a wrong fingerprint, a missing fingerprint, and a changed byte all refuse", () => {
  const offer = as(ALICE, () => invite.create({ label: "web-app" }));
  assert.throws(() => as(BOB, () => invite.accept(offer.token, "0000 0000 0000 0000 0000 0000 0000 0000")),
    /does not match/);
  assert.throws(() => as(BOB, () => invite.accept(offer.token, null)), /needs the fingerprint/);
  assert.throws(() => as(BOB, () => invite.accept(offer.token, "EDD0")), /holds 32 characters/);

  const [prefix, body, signature] = offer.token.split(".");
  const raw = Buffer.from(body, "base64url").toString("utf8").replace('"label":"alice"', '"label":"mallo"');
  const changed = [prefix, Buffer.from(raw).toString("base64url"), signature].join(".");
  assert.throws(() => invite.open(changed), /signature/);
  assert.throws(() => invite.open("hello"), /not an openmsg invitation/);
});

test("an invitation that expired reaches no directory", () => {
  const offer = as(ALICE, () => invite.create({ label: "old", hours: 1 }));
  const later = Date.now() + 2 * 3600 * 1000;
  assert.throws(() => as(BOB, () => invite.accept(offer.token, offer.fingerprint, { now: later })), /expired/);
  assert.equal(as(BOB, () => directory.member(offer.project.id, alice.ownerId)), null);
});

test("a revoked owner keeps its record and stops being a member", () => {
  const offer = as(ALICE, () => invite.create({ label: "web-app" }));
  as(BOB, () => invite.accept(offer.token, offer.fingerprint));
  const id = offer.project.id;
  assert.ok(as(BOB, () => directory.member(id, alice.ownerId)));
  const record = as(BOB, () => directory.revoke(id, alice.ownerId, "key on a lost laptop"));
  assert.deepEqual(record.keys, alice.keys, "the revoked list keeps the keys");
  assert.equal(as(BOB, () => directory.member(id, alice.ownerId)), null);
  assert.equal(as(BOB, () => directory.isRevoked(id, alice.ownerId)), true);
  assert.throws(() => as(BOB, () => invite.accept(offer.token, offer.fingerprint)), /revoked/);
  assert.throws(() => as(BOB, () => directory.revoke(id, "o_12345678")), /no member/);
});
