// Tests for a message that goes to a directory. Bob holds sessions in two
// directories. A session ends, and a message for it arrives. A message names
// a directory, and no session. The vendor of the tests is "cursor".
// Run: node --test
import { test } from "node:test";
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
const ALICE = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-pa-"));
const BOB = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-pb-"));
const WORK = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-pw-")));
const SHOP = path.join(WORK, "shop");
const BLOG = path.join(WORK, "blog");
fs.mkdirSync(SHOP);
fs.mkdirSync(BLOG);
process.env.OPENMSG_OPEN_VENDORS = "cursor";

const identity = await import("../src/identity.mjs");
const directory = await import("../src/directory.mjs");
const invite = await import("../src/invite.mjs");
const permissions = await import("../src/permissions.mjs");
const published = await import("../src/published.mjs");
const inbound = await import("../src/inbound.mjs");
const outbox = await import("../src/outbox.mjs");
const remote = await import("../src/remote.mjs");
const gateway = await import("../src/gateway.mjs");
const projectbox = await import("../src/projectbox.mjs");
const { register } = await import("../src/selfregistry.mjs");
const { runHook } = await import("../src/hook.mjs");

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
const FIRST = { vendor: "cursor", id: "conv-shop-1", name: "shop-1", cwd: SHOP };
const SECOND = { vendor: "cursor", id: "conv-shop-2", name: "shop-2", cwd: SHOP };
const WRITER = { vendor: "cursor", id: "conv-blog-1", name: "blog-1", cwd: BLOG };
const start = (s) => as(BOB, () => register(s));
const end = (s) => fs.rmSync(path.join(BOB, "agents", `${s.vendor}-${s.id}.json`), { force: true });
start(FIRST);
start(WRITER);
const offer = as(ALICE, () => invite.create({ label: "web-app" }));
const taken = as(BOB, () => invite.accept(offer.token, offer.fingerprint));
as(ALICE, () => invite.accept(taken.reply.token, taken.mine));
const PROJECT = offer.project.id;
as(BOB, () => permissions.set(PROJECT, alice.ownerId, "accept"));
as(BOB, () => published.setOpen(PROJECT, true));

let read = [];
const stub = async (agent, message, { text }) => {
  read.push({ session: agent.id, text });
  return { delivered: true, transport: "stub" };
};
function letter(session, text, { vendor = "cursor", ...more } = {}) {
  return as(ALICE, () => {
    const message = remote.createRemote({
      from: { owner: alice.ownerId, vendor: "claude", id: "ses_alice", name: "api-worker" },
      to: { owner: bob.ownerId, vendor, id: session, name: session },
      project: { id: PROJECT, label: "web-app" },
      target: { owner: bob.ownerId, project: PROJECT, session, epoch: 1 },
      text,
      ...more,
    });
    return remote.pack(message, { recipient: directory.member(PROJECT, bob.ownerId) });
  });
}
const receive = (wire) => asAsync(BOB, () => gateway.receive(wire, { deliver: stub }));
const state = (wire) => as(BOB, () => inbound.find(wire.messageId));

async function hookOf(session) {
  const input = JSON.stringify({ conversation_id: session.id, hook_event_name: "sessionStart", workspace_roots: [session.cwd] });
  const stdin = process.stdin;
  const { Readable } = await import("node:stream");
  Object.defineProperty(process, "stdin", { value: Readable.from([input]), configurable: true });
  try {
    return await asAsync(BOB, () => runHook("cursor"));
  } finally {
    Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
  }
}

test("the routing data gives each directory by its name, and never a path", async () => {
  const { routing, presence } = await asAsync(BOB, () => gateway.descriptions(PROJECT));
  const shop = routing.find((r) => r.alias === "project:shop");
  assert.deepEqual(
    { vendor: shop.vendor, session: shop.session, epoch: shop.epoch, live: shop.live },
    { vendor: "project", session: "place:shop", epoch: 1, live: true },
  );
  assert.ok(routing.some((r) => r.alias === "project:blog"));
  assert.ok(presence.some((p) => p.alias === "project:shop@bob"));
  assert.doesNotMatch(JSON.stringify({ routing, presence }), new RegExp(WORK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("a message for a directory reaches a session that runs there", async () => {
  read = [];
  const wire = letter("place:shop", "MARKER-PLACE", { vendor: "project" });
  const out = await receive(wire);
  assert.equal(out.status, "adapter-accepted");
  assert.equal(read.length, 1);
  assert.equal(read[0].session, FIRST.id);
  assert.match(read[0].text, /MARKER-PLACE/);
  assert.match(read[0].text, /It is for the directory shop, and not for one session/);
  assert.match(read[0].text, /--reply-to/);
});

test("a message for a session that ended reaches another session of its directory", async () => {
  start(SECOND);
  end(FIRST);
  read = [];
  const wire = letter(FIRST.id, "MARKER-MOVED");
  const out = await receive(wire);
  assert.equal(out.status, "adapter-accepted");
  assert.equal(read.length, 1);
  assert.equal(read[0].session, SECOND.id, "the session of the same directory took it, and not the one of the blog");
  assert.match(read[0].text, /It was for the session cursor:shop-1, which ended/);
  assert.match(read[0].text, /you do not hold that conversation/);
  assert.equal(state(wire).deliveredTo, SECOND.id);

  // The name of the session that ended stays in the routing data, so a
  // sender that holds the name can still write to it.
  const { routing, presence } = await asAsync(BOB, () => gateway.descriptions(PROJECT));
  const old = routing.find((r) => r.alias === "cursor:shop-1");
  assert.equal(old.session, FIRST.id);
  assert.equal(old.live, false);
  assert.equal(presence.find((p) => p.alias === "cursor:shop-1@bob").status, "ended");
});

test("with no session in the directory, the message waits, and the next session there takes it", async () => {
  end(SECOND);
  read = [];
  const wire = letter(FIRST.id, "MARKER-WAITS", { ttlMs: remote.WAIT_TTL_MS });
  const out = await receive(wire);
  assert.equal(out.status, "queued");
  assert.equal(out.transport, "project-box");
  assert.equal(read.length, 0, "no session of another directory read it");
  assert.equal(as(BOB, () => projectbox.waiting(SHOP)).length, 1);

  // The owner sees what waits, for whom it was, and no text.
  const { stdout } = await run(process.execPath, [CLI, "waiting"], { env: { ...process.env, OPENMSG_HOME: BOB } });
  assert.match(stdout, /from claude:api-worker@alice/);
  assert.match(stdout, /It was for the session cursor:shop-1, which ended/);
  assert.doesNotMatch(stdout, /MARKER-WAITS/);

  // A session of the blog starts, and it takes nothing.
  assert.deepEqual(await hookOf({ ...WRITER, id: "conv-blog-2" }), {});

  // A new session starts in the shop.
  const third = { vendor: "cursor", id: "conv-shop-3", name: "shop-3", cwd: SHOP };
  const got = await hookOf(third);
  assert.match(got.additional_context, /MARKER-WAITS/);
  assert.match(got.additional_context, /From: +claude:api-worker@alice/);
  assert.match(got.additional_context, /It was for the session cursor:shop-1, which ended/);
  const row = state(wire);
  assert.equal(row.status, "adapter-accepted");
  assert.equal(row.deliveredTo, third.id);
  assert.equal(row.unreported, true, "the gateway tells the sender later");
  assert.deepEqual(await hookOf(third), {}, "the message goes one time");
});

test("a message that passed its deadline in the box reaches no model", async () => {
  end({ vendor: "cursor", id: "conv-shop-3" });
  const wire = letter("place:shop", "MARKER-LATE", { vendor: "project", now: Date.now() - remote.DEFAULT_TTL_MS + 300 });
  assert.equal((await receive(wire)).status, "queued");
  await new Promise((r) => setTimeout(r, 400));
  const got = await hookOf({ vendor: "cursor", id: "conv-shop-4", name: "shop-4", cwd: SHOP });
  assert.deepEqual(got, {});
  assert.equal(state(wire).status, "expired");
});

test("a Claude session that ended gives the command that opens its conversation again", () => {
  const record = as(BOB, () => inbound.list()[0]);
  const text = remote.render({
    ...record,
    placed: { place: "shop", wasFor: { alias: "claude:shop-0d", vendor: "claude", session: "0884038b-2816-4578" } },
  });
  assert.match(text, /It was for the session claude:shop-0d, which ended/);
  assert.match(text, /claude --resume 0884038b-2816-4578/);
});

test("a name that is no directory of the project, and a session that nobody saw, are refused", async () => {
  const one = await receive(letter("place:secrets", "to a place that does not exist", { vendor: "project" }));
  assert.equal(one.status, "refused");
  assert.equal(one.reason, "not-published");
  const two = await receive(letter("conv-never-seen", "to a session that never ran"));
  assert.equal(two.status, "refused");
  assert.equal(two.reason, "not-published");
});

test("a project that is not open gives no directory, and a session that ended takes nothing", async () => {
  as(BOB, () => published.setOpen(PROJECT, false));
  const { routing } = await asAsync(BOB, () => gateway.descriptions(PROJECT));
  assert.equal(routing.filter((r) => r.vendor === "project").length, 0);
  assert.equal((await receive(letter("place:shop", "closed", { vendor: "project" }))).reason, "not-published");
  assert.equal((await receive(letter(FIRST.id, "closed too"))).reason, "not-published");
  as(BOB, () => published.setOpen(PROJECT, true));
});

test("the sender names a directory of another person, and the target holds the place", async () => {
  as(ALICE, () => gateway.saveSettings({ relay: "ws://127.0.0.1:1" }));
  as(ALICE, () =>
    directory.setRouting(PROJECT, bob.ownerId, [
      { alias: "project:shop", vendor: "project", name: "shop", owner: bob.ownerId, project: PROJECT, session: "place:shop", epoch: 1, live: false },
    ]),
  );
  const { stdout } = await run(process.execPath, [CLI, "send", "project:shop@bob", "MARKER-CLI"], {
    env: { ...process.env, OPENMSG_HOME: ALICE, OPENMSG_SELF: "claude:api-worker" },
  });
  assert.match(stdout, /waits on this machine for bob/);
  const [row] = as(ALICE, () => outbox.list());
  assert.equal(row.alias, "project:shop@bob");
  read = [];
  start(SECOND);
  const out = await receive(row.wire);
  assert.equal(out.status, "adapter-accepted");
  assert.equal(read[0].session, SECOND.id);
  assert.match(read[0].text, /MARKER-CLI/);
});
