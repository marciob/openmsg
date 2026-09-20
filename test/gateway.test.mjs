// Tests for the gateway of phase 3. The gateway of Bob runs in its own
// process, with its own OPENMSG_HOME, as a second person on this machine. The
// adapter is a stub that writes what an agent would read.
// Run: node --test
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const ALICE = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-ga-"));
const BOB = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-gb-"));
const STUB_OUT = path.join(BOB, "agent-read.txt");

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

// Bob publishes one session, and that session is the only way in.
const SESSION = { vendor: "cursor", id: "conv-bob-live", name: "reviewer" };
as(BOB, () => register({ ...SESSION, cwd: "/work/web-app" }));

// The gateway of Bob runs in its own process, with a stub adapter.
const script = path.join(BOB, "gateway.mjs");
fs.writeFileSync(
  script,
  `import fs from "node:fs";
   const gateway = await import(${JSON.stringify(path.join(ROOT, "src/gateway.mjs"))});
   const running = await gateway.serve({
     port: 0,
     host: "127.0.0.1",
     deliver: async (agent, message, { text }) => {
       fs.appendFileSync(process.env.STUB_OUT, JSON.stringify({ agent: agent.id, text }) + "\\n");
       return { delivered: true, transport: "stub" };
     },
   });
   console.log(JSON.stringify({ url: running.url }));
  `,
);

const child = spawn(process.execPath, [script], {
  env: { ...process.env, OPENMSG_HOME: BOB, STUB_OUT },
  stdio: ["ignore", "pipe", "pipe"],
});
const ENDPOINT = await new Promise((resolve, reject) => {
  let out = "";
  const timer = setTimeout(() => reject(new Error(`the gateway did not start: ${out}`)), 10_000);
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
after(() => child.kill());

// The two people join one project. Bob names the address of its gateway.
const offer = as(ALICE, () => invite.create({ label: "web-app" }));
const taken = as(BOB, () => invite.accept(offer.token, offer.fingerprint, { endpoint: ENDPOINT }));
as(ALICE, () => invite.accept(taken.reply.token, taken.mine));
const PROJECT = offer.project.id;
const BOB_IN_ALICE = () => as(ALICE, () => directory.member(PROJECT, bob.ownerId));

function stubLines() {
  try {
    return fs.readFileSync(STUB_OUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

async function letterTo(row, text, extra = {}) {
  return asAsync(ALICE, async () => {
    const message = remote.createRemote({
      from: { owner: alice.ownerId, vendor: "claude", id: "ses_alice", name: "api-worker" },
      project: { id: PROJECT, label: "web-app" },
      target: { owner: bob.ownerId, project: PROJECT, session: row.session, epoch: row.epoch, ...extra },
      text,
    });
    return gateway.send(BOB_IN_ALICE(), remote.pack(message, { recipient: BOB_IN_ALICE() }));
  });
}

test("the invitation carried the address of the gateway of Bob", () => {
  assert.equal(BOB_IN_ALICE().endpoint, ENDPOINT);
});

test("a gateway publishes nothing until the owner publishes a session", async () => {
  const empty = await asAsync(ALICE, () => gateway.routingOf(BOB_IN_ALICE(), PROJECT));
  assert.deepEqual(empty.routing, []);
  assert.deepEqual(empty.presence, []);

  as(BOB, () => published.publish(PROJECT, SESSION));
  const answer = await asAsync(ALICE, () => gateway.routingOf(BOB_IN_ALICE(), PROJECT));
  assert.equal(answer.routing.length, 1);
  assert.equal(answer.routing[0].session, "conv-bob-live");
  assert.equal(answer.routing[0].epoch, 1);
  assert.equal(answer.presence[0].alias, "cursor:reviewer@bob");
  // Presence is for a person, and routing data is for a gateway. Neither one
  // carries a working directory, a socket path, or a token.
  const text = JSON.stringify(answer);
  for (const hidden of ["/work/web-app", "cwd", "socket", "token", "transport"]) {
    assert.ok(!text.includes(hidden), `the answer carries ${hidden}`);
  }
});

test("a gateway answers no routing data to a person outside the project", async () => {
  const stranger = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-gm-"));
  as(stranger, () => identity.create({ label: "mallory" }));
  as(stranger, () => directory.put({ id: PROJECT, label: "web-app" }, bob, { endpoint: ENDPOINT }));
  await assert.rejects(
    asAsync(stranger, () => gateway.routingOf(as(stranger, () => directory.member(PROJECT, bob.ownerId)), PROJECT)),
    /403|not a member/,
  );
});

test("an unknown sender stays held, outside the context of the model", async () => {
  const row = (await asAsync(ALICE, () => gateway.routingOf(BOB_IN_ALICE(), PROJECT))).routing[0];
  const out = await letterTo(row, "the migration drops a column");
  assert.equal(out.status, "held");
  assert.equal(stubLines().length, 0, "no agent read the message");

  const held = as(BOB, () => inbound.list({ status: "held" }));
  assert.equal(held.length, 1);
  assert.equal(held[0].from.label, "alice");
  assert.equal(held[0].message.parts[0].text, "the migration drops a column");

  // The owner accepts the message, and only then the agent reads it.
  const released = await asAsync(BOB, () =>
    gateway.release(held[0], { deliver: async (agent, m, { text }) => {
      fs.appendFileSync(STUB_OUT, JSON.stringify({ agent: agent.id, text }) + "\n");
      return { delivered: true, transport: "stub" };
    } }),
  );
  assert.equal(released.status, "adapter-accepted");
  const read = stubLines();
  assert.equal(read.length, 1);
  assert.match(read[0].text, /the migration drops a column/);
  assert.match(read[0].text, /does not approve any action/);
  assert.match(read[0].text, new RegExp(identity.fingerprint(alice)));
});

test("a standing permission of accept lets the next message through", async () => {
  as(BOB, () => permissions.set(PROJECT, alice.ownerId, "accept"));
  const row = (await asAsync(ALICE, () => gateway.routingOf(BOB_IN_ALICE(), PROJECT))).routing[0];
  const out = await letterTo(row, "the second message");
  assert.equal(out.status, "adapter-accepted");
  assert.match(stubLines().at(-1).text, /the second message/);
  assert.equal(stubLines().at(-1).agent, "conv-bob-live");
});

test("a standing permission of refuse stops a message at the gateway", async () => {
  as(BOB, () => permissions.set(PROJECT, alice.ownerId, "refuse"));
  const row = (await asAsync(ALICE, () => gateway.routingOf(BOB_IN_ALICE(), PROJECT))).routing[0];
  const before = stubLines().length;
  const out = await letterTo(row, "you refused me");
  assert.equal(out.status, "refused");
  assert.equal(out.reason, "permission-refuse");
  assert.equal(stubLines().length, before);
  as(BOB, () => permissions.set(PROJECT, alice.ownerId, "accept"));
});

test("a message for an old epoch is refused, and never delivered", async () => {
  const row = (await asAsync(ALICE, () => gateway.routingOf(BOB_IN_ALICE(), PROJECT))).routing[0];
  const before = stubLines().length;
  const out = await letterTo(row, "for a session that restarted", { epoch: row.epoch - 1 });
  assert.equal(out.status, "refused");
  assert.equal(out.reason, "old-epoch");
  assert.equal(stubLines().length, before);
});

test("a session that restarts takes a new epoch, and the old address stops", async () => {
  as(BOB, () => register({ vendor: "cursor", id: "conv-bob-new", name: "reviewer", cwd: "/work/web-app" }));
  const next = as(BOB, () => published.publish(PROJECT, { vendor: "cursor", id: "conv-bob-new", name: "reviewer" }));
  assert.equal(next.epoch, 2, "a new session under one name is a new epoch");
  const answer = await asAsync(ALICE, () => gateway.routingOf(BOB_IN_ALICE(), PROJECT));
  assert.equal(answer.routing[0].session, "conv-bob-new");
  const out = await letterTo({ session: "conv-bob-live", epoch: 1 }, "for the session that ended");
  assert.equal(out.status, "refused");
  assert.equal(out.reason, "not-published");
});
