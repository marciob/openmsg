// Tests for a project that takes every session of a machine. Bob holds two
// sessions, and later a third one. The vendor of the tests is "cursor",
// because its sessions come from a directory of the test home.
// Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ALICE = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-oa-"));
const BOB = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-ob-"));
process.env.OPENMSG_OPEN_VENDORS = "cursor";

const identity = await import("../src/identity.mjs");
const directory = await import("../src/directory.mjs");
const invite = await import("../src/invite.mjs");
const permissions = await import("../src/permissions.mjs");
const published = await import("../src/published.mjs");
const inbound = await import("../src/inbound.mjs");
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

const alice = as(ALICE, () => identity.create({ label: "alice" }));
const bob = as(BOB, () => identity.create({ label: "bob" }));
const NAMED = { vendor: "cursor", id: "conv-named", name: "reviewer" };
const OTHER = { vendor: "cursor", id: "conv-other", name: "builder" };
const LATER = { vendor: "cursor", id: "conv-later", name: "planner" };
as(BOB, () => register({ ...NAMED, cwd: "/work" }));
as(BOB, () => register({ ...OTHER, cwd: "/work" }));
const offer = as(ALICE, () => invite.create({ label: "web-app" }));
const taken = as(BOB, () => invite.accept(offer.token, offer.fingerprint));
as(ALICE, () => invite.accept(taken.reply.token, taken.mine));
const PROJECT = offer.project.id;
as(BOB, () => published.publish(PROJECT, NAMED));
as(BOB, () => permissions.set(PROJECT, alice.ownerId, "accept"));

let read = [];
const stub = async (agent, message, { text }) => {
  read.push({ session: agent.id, text });
  return { delivered: true, transport: "stub" };
};

function letter(session, text) {
  return as(ALICE, () => {
    const message = remote.createRemote({
      from: { owner: alice.ownerId, vendor: "claude", id: "ses_alice", name: "api-worker" },
      to: { owner: bob.ownerId, vendor: "cursor", id: session.id, name: session.name },
      project: { id: PROJECT, label: "web-app" },
      target: { owner: bob.ownerId, project: PROJECT, session: session.id, epoch: 1 },
      text,
    });
    return remote.pack(message, { recipient: directory.member(PROJECT, bob.ownerId) });
  });
}
const receive = (wire) => asAsync(BOB, () => gateway.receive(wire, { deliver: stub }));
const aliases = async () => (await asAsync(BOB, () => gateway.descriptions(PROJECT))).routing.map((r) => r.alias).sort();

test("the default holds: a session that the owner did not name is not reached", async () => {
  assert.deepEqual(await aliases(), ["cursor:reviewer"]);
  const out = await receive(letter(OTHER, "to a session with no name in the list"));
  assert.equal(out.status, "refused");
  assert.equal(out.reason, "not-published");
  assert.equal(read.length, 0);
});

test("an open project gives every session that runs, with the epoch 1", async () => {
  assert.equal(as(BOB, () => published.setOpen(PROJECT, true)), false);
  assert.equal(as(BOB, () => published.isOpen(PROJECT)), true);
  const { routing } = await asAsync(BOB, () => gateway.descriptions(PROJECT));
  assert.deepEqual(routing.map((r) => r.alias).sort(), ["cursor:builder", "cursor:reviewer"]);
  const builder = routing.find((r) => r.alias === "cursor:builder");
  assert.equal(builder.session, OTHER.id);
  assert.equal(builder.epoch, 1);
  assert.equal(builder.live, true);
  assert.doesNotMatch(JSON.stringify(routing), /\/work/);
});

test("a message reaches a session that the owner did not name", async () => {
  read = [];
  const out = await receive(letter(OTHER, "MARKER-OPEN"));
  assert.equal(out.status, "adapter-accepted");
  assert.equal(read.length, 1);
  assert.equal(read[0].session, OTHER.id);
  assert.match(read[0].text, /MARKER-OPEN/);
});

test("a session that starts later is reached with no new command", async () => {
  as(BOB, () => register({ ...LATER, cwd: "/work" }));
  read = [];
  const out = await receive(letter(LATER, "to the new session"));
  assert.equal(out.status, "adapter-accepted");
  assert.equal(read[0].session, LATER.id);
});

test("a session that does not run is not reached, in an open project too", async () => {
  const out = await receive(letter({ id: "conv-nobody", name: "ghost" }, "to nobody"));
  assert.equal(out.status, "refused");
  assert.equal(out.reason, "not-published");
});

test("the permission for the sender still holds in an open project", async () => {
  as(BOB, () => permissions.set(PROJECT, alice.ownerId, "hold"));
  read = [];
  const out = await receive(letter(OTHER, "MARKER-HELD"));
  assert.equal(out.status, "held");
  assert.equal(read.length, 0);
  as(BOB, () => permissions.set(PROJECT, alice.ownerId, "accept"));
});

test("the owner closes the project, and only the named session stays", async () => {
  assert.equal(as(BOB, () => published.setOpen(PROJECT, false)), true);
  const out = await receive(letter(OTHER, "after the owner closed it"));
  assert.equal(out.status, "refused");
  assert.equal(out.reason, "not-published");
  read = [];
  assert.equal((await receive(letter(NAMED, "the named session"))).status, "adapter-accepted");
  assert.equal(read[0].session, NAMED.id);
  assert.equal(as(BOB, () => inbound.list()).filter((r) => r.status === "adapter-accepted").length, 3);
});
