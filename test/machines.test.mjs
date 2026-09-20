// Two machines of one owner, online at the same time.
//
// The relay cannot read a message, so it does not know which machine holds
// the session that a message names. It gives the message to every machine of
// that owner. The machine that holds the session takes it. The others cannot
// even open it, because the sender sealed it for the key of one machine.
// Run: node --test
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const ALICE = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-ma-"));
const DESK = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-md-"));
const LAPTOP = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-ml-"));
const RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-mr-"));
process.env.OPENMSG_RELAY_HOME = RELAY_HOME;

const identity = await import("../src/identity.mjs");
const device = await import("../src/device.mjs");
const directory = await import("../src/directory.mjs");
const invite = await import("../src/invite.mjs");
const permissions = await import("../src/permissions.mjs");
const published = await import("../src/published.mjs");
const remote = await import("../src/remote.mjs");
const gateway = await import("../src/gateway.mjs");
const relay = await import("../src/relay.mjs");
const relaylink = await import("../src/relaylink.mjs");
const { saveSettings } = await import("../src/settings.mjs");
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
const bob = as(DESK, () => identity.create({ label: "bob" }));
const running = await relay.serve({ port: 0, host: "127.0.0.1" });
const children = [];
after(() => {
  for (const c of children) c.kill();
  return running.close();
});
for (const home of [ALICE, DESK, LAPTOP]) as(home, () => saveSettings({ relay: running.url }));

const offer = as(ALICE, () => invite.create({ label: "web-app" }));
const taken = as(DESK, () => invite.accept(offer.token, offer.fingerprint));
as(ALICE, () => invite.accept(taken.reply.token, taken.mine));
const PROJECT = offer.project.id;
as(DESK, () => permissions.set(PROJECT, alice.ownerId, "accept"));

// The second machine of Bob: the public record of its owner, its own keys,
// and a delegation. It learns the project from the relay.
fs.mkdirSync(path.join(LAPTOP, "keys"), { recursive: true });
fs.copyFileSync(path.join(DESK, "keys", "identity.json"), path.join(LAPTOP, "keys", "identity.json"));
const laptop = as(LAPTOP, () => device.create({ label: "laptop" }));
const grant = as(DESK, () => device.grant(device.readRequest(as(LAPTOP, () => device.request())), { projects: [PROJECT] }));
as(LAPTOP, () => device.saveDelegation(grant.record));

// One session on each machine of Bob.
const DESK_SESSION = { vendor: "cursor", id: "conv-desk", name: "desk" };
const LAPTOP_SESSION = { vendor: "cursor", id: "conv-laptop", name: "laptop" };
as(DESK, () => register({ ...DESK_SESSION, cwd: "/work" }));
as(DESK, () => published.publish(PROJECT, DESK_SESSION));
as(LAPTOP, () => register({ ...LAPTOP_SESSION, cwd: "/work" }));

function startMachine(home, tag) {
  const out = path.join(home, `read-${tag}.txt`);
  const script = path.join(home, `gateway-${tag}.mjs`);
  fs.writeFileSync(
    script,
    `import fs from "node:fs";
     const gateway = await import(${JSON.stringify(path.join(ROOT, "src/gateway.mjs"))});
     await gateway.joinRelay(process.env.RELAY_URL, {
       log: (line) => console.log("${tag}:", line),
       deliver: async (agent, message, { text }) => {
         fs.appendFileSync(process.env.READ_OUT, agent.id + " | " + text.replace(/\\n/g, " ") + "\\n");
         return { delivered: true, transport: "stub" };
       },
     });
     console.log("ready");`,
  );
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, OPENMSG_HOME: home, OPENMSG_RELAY_HOME: RELAY_HOME, RELAY_URL: running.url, READ_OUT: out },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const ready = new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error(`${tag} did not start: ${text}`)), 10_000);
    child.stdout.on("data", (d) => {
      text += d;
      if (text.includes("connected as")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (d) => (text += d));
  });
  const reads = () => {
    try {
      return fs.readFileSync(out, "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  return { child, ready, reads };
}

async function aliceSends(text, row) {
  return asAsync(ALICE, async () => {
    const link = await relaylink.open(running.url);
    const message = remote.createRemote({
      from: { owner: alice.ownerId, vendor: "claude", id: "ses_alice", name: "api-worker" },
      project: { id: PROJECT, label: "web-app" },
      target: { owner: bob.ownerId, project: PROJECT, session: row.session, epoch: row.epoch },
      text,
    });
    const answer = await link.send(
      remote.pack(message, { recipient: directory.member(PROJECT, bob.ownerId), sealTo: row.sealTo }),
    );
    link.close();
    return { messageId: message.messageId, answer };
  });
}

const desk = startMachine(DESK, "desk");
await desk.ready;
const lap = startMachine(LAPTOP, "laptop");
await lap.ready;
await sleep(500);

test("both machines of one owner hold a connection at the same time", async () => {
  // The laptop learned the project from the relay, and it published its own
  // session there.
  as(LAPTOP, () => published.publish(PROJECT, LAPTOP_SESSION));
  assert.ok(as(LAPTOP, () => directory.member(PROJECT, alice.ownerId)), "the laptop knows Alice");
  // The relay gave the directory to the laptop at its connection.
  assert.ok(as(LAPTOP, () => directory.project(PROJECT)), "and it knows the project");
});

test("one question about routing gives the sessions of every machine", async () => {
  const answer = await asAsync(ALICE, async () => {
    const link = await relaylink.open(running.url);
    const out = await gateway.routingOverRelay(link, directory.member(PROJECT, bob.ownerId), PROJECT);
    link.close();
    return out;
  });
  const sessions = answer.routing.map((r) => r.session).sort();
  assert.deepEqual(sessions, ["conv-desk", "conv-laptop"], "the two machines answered");
  const keys = new Set(answer.routing.map((r) => JSON.stringify(r.sealTo)));
  assert.equal(keys.size, 2, "each row carries the key of its own machine");
});

test("a message reaches the machine that holds the session, and no other one", async () => {
  const rows = as(ALICE, () => directory.routingOf(PROJECT, bob.ownerId).rows);
  const deskRow = rows.find((r) => r.session === "conv-desk");
  const laptopRow = rows.find((r) => r.session === "conv-laptop");

  const first = await aliceSends("for the desk of Bob", deskRow);
  assert.equal(first.answer.type, "stored");
  await sleep(800);
  assert.equal(desk.reads().length, 1, "the desk read it");
  assert.match(desk.reads()[0], /conv-desk \| .*for the desk of Bob/);
  assert.equal(lap.reads().length, 0, "the laptop read nothing");

  const second = await aliceSends("for the laptop of Bob", laptopRow);
  assert.equal(second.answer.type, "stored");
  await sleep(800);
  assert.equal(lap.reads().length, 1, "the laptop read it");
  assert.match(lap.reads()[0], /conv-laptop \| .*for the laptop of Bob/);
  assert.equal(desk.reads().length, 1, "and the desk read nothing new");

  // The relay holds neither message any more: the machine that took each one
  // acknowledged it.
  assert.equal(relay.queued(bob.ownerId).length, 0);
});

test("a message for a machine that is offline waits, and no other machine eats it", async () => {
  const rows = as(ALICE, () => directory.routingOf(PROJECT, bob.ownerId).rows);
  const laptopRow = rows.find((r) => r.session === "conv-laptop");
  lap.child.kill();
  await sleep(400);

  const sent = await aliceSends("the laptop was away", laptopRow);
  assert.equal(sent.answer.type, "stored");
  await sleep(700);
  // The desk is online, it cannot open a message that is not for its key,
  // and it does not acknowledge one. The message waits.
  assert.equal(desk.reads().length, 1, "the desk read nothing new");
  assert.equal(relay.queued(bob.ownerId).length, 1, "the message waits for the laptop");

  const again = startMachine(LAPTOP, "laptop2");
  await again.ready;
  await sleep(800);
  assert.equal(again.reads().length, 1, "the laptop took it when it came back");
  assert.match(again.reads()[0], /the laptop was away/);
  assert.equal(relay.queued(bob.ownerId).length, 0);
});
