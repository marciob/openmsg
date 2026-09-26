// Tests for the delegation of section 3.2 of the spec: a machine signs with
// its own key, under a record that the owner key signed.
//
// Three homes stand for three machines. ALICE holds the owner key of Alice.
// LAPTOP holds the public record of Alice and its own keys, and no private
// key of the owner. BOB is the other person.
// Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ALICE = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-da-"));
const LAPTOP = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-dl-"));
const BOB = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-db-"));

const identity = await import("../src/identity.mjs");
const device = await import("../src/device.mjs");
const directory = await import("../src/directory.mjs");
const invite = await import("../src/invite.mjs");
const remote = await import("../src/remote.mjs");
const { canonicalBytes } = await import("../src/canonical.mjs");
const seal = await import("../src/seal.mjs");

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
const offer = as(ALICE, () => invite.create({ label: "web-app" }));
const taken = as(BOB, () => invite.accept(offer.token, offer.fingerprint));
as(ALICE, () => invite.accept(taken.reply.token, taken.mine));
const PROJECT = offer.project.id;

// The second machine of Alice: the public record of the owner, its own keys,
// and no private key of the owner.
fs.mkdirSync(path.join(LAPTOP, "keys"), { recursive: true });
fs.copyFileSync(path.join(ALICE, "keys", "identity.json"), path.join(LAPTOP, "keys", "identity.json"));
const laptop = as(LAPTOP, () => device.create({ label: "laptop" }));

test("a machine id comes from the keys of that machine", () => {
  assert.match(laptop.deviceId, /^d_[0-9a-f]{8}$/);
  assert.equal(laptop.deviceId, device.deviceIdOf(laptop.keys));
  const lie = { ...laptop, deviceId: "d_00000000" };
  fs.writeFileSync(path.join(LAPTOP, "keys", "device.json"), JSON.stringify(lie));
  assert.throws(() => as(LAPTOP, () => device.load()), /claims d_00000000/);
  fs.writeFileSync(path.join(LAPTOP, "keys", "device.json"), JSON.stringify(laptop));
});

test("the second machine holds no private key of the owner", () => {
  assert.equal(as(LAPTOP, () => identity.hasPrivateKeys()), false);
  assert.equal(as(ALICE, () => identity.hasPrivateKeys()), true);
  assert.throws(() => as(LAPTOP, () => identity.sign(Buffer.from("x"))), /holds no signing key of the owner/);
  // It still knows who its owner is, because the public record travels.
  assert.equal(as(LAPTOP, () => identity.load()).ownerId, alice.ownerId);
});

test("the owner answers a request, and the machine keeps the answer", () => {
  const ask = as(LAPTOP, () => device.request());
  const read = device.readRequest(ask);
  assert.equal(read.device, laptop.deviceId);
  assert.deepEqual(read.keys, laptop.keys);

  const { record, token } = as(ALICE, () => device.grant(read, { projects: [PROJECT] }));
  assert.equal(record.owner, alice.ownerId);
  assert.equal(record.device, laptop.deviceId);
  as(LAPTOP, () => device.saveDelegation(device.readGrant(token)));
  assert.equal(as(LAPTOP, () => device.delegation()).device, laptop.deviceId);

  // The scope of section 5.5 holds, and the date holds.
  assert.equal(device.verify(record, alice, { project: PROJECT }), null);
  assert.match(device.verify(record, alice, { project: "p_other" }), /does not cover/);
  assert.match(device.verify(record, alice, { project: PROJECT, now: Date.now() + 400 * 24 * 3600 * 1000 }), /ended at/);
  assert.match(device.verify(record, bob, { project: PROJECT }), /names the owner/);
});

test("a delegation with a changed byte is refused", () => {
  const ask = device.readRequest(as(LAPTOP, () => device.request()));
  const { record } = as(ALICE, () => device.grant(ask, { projects: [PROJECT] }));
  assert.match(device.verify({ ...record, label: "another name" }, alice, { project: PROJECT }), /did not sign/);
  assert.match(device.verify({ ...record, projects: "all" }, alice, { project: PROJECT }), /did not sign/);
  // A machine cannot write its own delegation, because it has no owner key.
  const forged = as(LAPTOP, () => {
    const { signature, ...body } = record;
    return { ...body, signature: { alg: "Ed25519", by: alice.ownerId, value: device.sign(canonicalBytes(body)).toString("base64url") } };
  });
  assert.match(device.verify(forged, alice, { project: PROJECT }), /did not sign/);
});

function letterFromLaptop(text) {
  return as(LAPTOP, () => {
    const message = remote.createRemote({
      from: { owner: alice.ownerId, vendor: "claude", id: "ses_laptop", name: "api-worker" },
      project: { id: PROJECT, label: "web-app" },
      target: { owner: bob.ownerId, project: PROJECT, session: "conv-bob", epoch: 1 },
      text,
    });
    return remote.pack(message, { recipient: as(LAPTOP, () => directory.member(PROJECT, bob.ownerId)) });
  });
}

test("a message that a machine signed opens, and the receiver names the machine", () => {
  // The laptop of Alice needs Bob in its own directory to seal for him.
  as(LAPTOP, () => directory.put({ id: PROJECT, label: "web-app" }, bob));
  const wire = letterFromLaptop("this message left my laptop");
  const { message, verified } = as(BOB, () => remote.open(wire));
  assert.equal(message.parts[0].text, "this message left my laptop");
  assert.equal(verified.owner, alice.ownerId, "the sender is the person");
  assert.equal(verified.device, laptop.deviceId, "and the machine is known too");
  assert.equal(verified.deviceLabel, "laptop");
  assert.equal(message.openmsg.signature, undefined);
  assert.match(remote.render({ message, verified }), /device="laptop"/);
});

test("a message from a machine that the owner never named is refused", () => {
  const stranger = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-dx-"));
  fs.mkdirSync(path.join(stranger, "keys"), { recursive: true });
  fs.copyFileSync(path.join(ALICE, "keys", "identity.json"), path.join(stranger, "keys", "identity.json"));
  as(stranger, () => device.create({ label: "a machine of nobody" }));
  // It writes its own delegation, with its own key in the place of the owner.
  const mine = as(stranger, () => device.load());
  const body = {
    kind: "delegation",
    version: 2,
    owner: alice.ownerId,
    device: mine.deviceId,
    label: mine.label,
    keys: mine.keys,
    projects: "all",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
  as(stranger, () => {
    device.saveDelegation({
      ...body,
      signature: { alg: "Ed25519", by: alice.ownerId, value: device.sign(canonicalBytes(body)).toString("base64url") },
    });
    directory.put({ id: PROJECT, label: "web-app" }, bob);
  });
  const message = () =>
    remote.createRemote({
      from: { owner: alice.ownerId, vendor: "claude", id: "s", name: "x" },
      project: { id: PROJECT, label: "web-app" },
      target: { owner: bob.ownerId, project: PROJECT, session: "conv-bob", epoch: 1 },
      text: "trust me",
    });

  // The machine refuses to use a delegation that its owner did not sign.
  assert.throws(
    () => as(stranger, () => remote.pack(message(), { recipient: directory.member(PROJECT, bob.ownerId) })),
    (e) => e.reason === "bad-delegation",
  );

  // A sender that does not make that check is refused by the receiver.
  const wire = as(stranger, () => {
    const view = remote.signedView(message());
    view.openmsg.delegation = device.delegation();
    view.openmsg.signature = {
      alg: "Ed25519",
      by: alice.ownerId,
      device: mine.deviceId,
      value: device.sign(canonicalBytes(view)).toString("base64url"),
    };
    const header = remote.clearHeaderOf(view);
    return { ...header, seal: seal.seal(canonicalBytes(view), bob.keys.encryption, canonicalBytes(header)) };
  });
  assert.throws(() => as(BOB, () => remote.open(wire)), (e) => e.reason === "bad-delegation");
});

test("one revoked machine stops, and the identity of that person holds", () => {
  const wire = letterFromLaptop("after the laptop was lost");
  as(BOB, () => directory.revokeDevice(PROJECT, laptop.deviceId, "the laptop of alice was lost"));
  assert.throws(() => as(BOB, () => remote.open(wire)), (e) => e.reason === "revoked-device");
  assert.equal(as(BOB, () => directory.isRevoked(PROJECT, alice.ownerId)), false, "the person is not revoked");

  // Alice sends from the machine that holds the owner key, and it arrives.
  const fromOwner = as(ALICE, () => {
    const message = remote.createRemote({
      from: { owner: alice.ownerId, vendor: "claude", id: "ses_desk", name: "desk" },
      project: { id: PROJECT, label: "web-app" },
      target: { owner: bob.ownerId, project: PROJECT, session: "conv-bob", epoch: 1 },
      text: "the identity of alice holds",
    });
    return remote.pack(message, { recipient: directory.member(PROJECT, bob.ownerId) });
  });
  const { verified } = as(BOB, () => remote.open(fromOwner));
  assert.equal(verified.owner, alice.ownerId);
  assert.equal(verified.device, null, "the owner key signed this one");
});

test("a message sealed for one machine does not open on another machine", () => {
  // Bob seals for the laptop of Alice, and not for the owner key.
  const wire = as(BOB, () => {
    const message = remote.createRemote({
      from: { owner: bob.ownerId, vendor: "claude", id: "ses_bob", name: "reviewer" },
      project: { id: PROJECT, label: "web-app" },
      target: { owner: alice.ownerId, project: PROJECT, session: "ses_laptop", epoch: 1 },
      text: "for the laptop alone",
    });
    return remote.pack(message, { recipient: directory.member(PROJECT, alice.ownerId), sealTo: laptop.keys.encryption });
  });
  const { message } = as(LAPTOP, () => remote.open(wire));
  assert.equal(message.parts[0].text, "for the laptop alone");
  assert.throws(() => as(ALICE, () => remote.open(wire)), (e) => e.reason === "unseal-failed");
});
