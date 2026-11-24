// Tests for the Antigravity CLI, the command `agy`: discovery through the
// presence files that a live session holds open, the sender from
// ANTIGRAVITY_CONVERSATION_ID, the hooks file in its flat shape, and the
// answers of the Stop and SessionStart hooks.
// Section 7.0 of the spec of 0.1. Source: https://antigravity.google/docs/hooks/
// Run: node --test
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const run = promisify(execFile);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-agy-"));
process.env.HOME = ROOT;
process.env.OPENMSG_HOME = path.join(ROOT, ".openmsg");
const AGY = path.join(ROOT, ".gemini", "antigravity-cli");
process.env.OPENMSG_AGY_DIR = AGY;
fs.mkdirSync(path.join(AGY, "presence"), { recursive: true });
fs.mkdirSync(path.join(AGY, "annotations"), { recursive: true });
fs.mkdirSync(path.join(ROOT, ".gemini", "config"), { recursive: true });
const HOOKS = path.join(ROOT, ".gemini", "config", "hooks.json");
const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

const LIVE = "d6947e3a-e31b-4319-ba65-f96dba46ed9b";
const GONE = "be31cc19-4fa4-4f21-bb48-1cd351d39459";
// This test process holds the presence file of one session open, as agy does.
const held = fs.openSync(path.join(AGY, "presence", `${LIVE}.lock`), "w");
fs.writeFileSync(path.join(AGY, "presence", `${GONE}.lock`), "");
fs.writeFileSync(path.join(AGY, "annotations", `${LIVE}.pbtxt`), 'title:"Deletar \\"duas\\" skills"\n');
after(() => {
  fs.closeSync(held);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const registry = await import("../src/registry.mjs");
const { installHooks, uninstallHooks, agyConfig } = await import("../src/hookinstall.mjs");
const { runHook } = await import("../src/hook.mjs");
const mailbox = await import("../src/mailbox.mjs");
const { createMessage } = await import("../src/envelope.mjs");

async function hook(event, input) {
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin");
  Object.defineProperty(process, "stdin", { value: Readable.from([JSON.stringify(input)]), configurable: true });
  try {
    return await runHook("agy", event);
  } finally {
    Object.defineProperty(process, "stdin", stdin);
  }
}

test("discovery lists a session whose presence file a process holds, and not a file that nobody holds", async () => {
  const agents = await registry.agyAgents();
  assert.equal(agents.length, 1);
  const [a] = agents;
  assert.equal(a.vendor, "agy");
  assert.equal(a.id, LIVE);
  assert.equal(a.pid, process.pid);
  assert.equal(a.title, 'Deletar "duas" skills');
  assert.equal(a.name, registry.agyName(a.cwd, LIVE));
  assert.match(a.name, /-ed9b$/);
  assert.deepEqual(a.transport, { kind: "mailbox" });
});

test("the output of lsof -F gives each file with its process", () => {
  const map = registry.parseHolders("p9817\nf79\nn/x/presence/a.lock\np42\nn/x/presence/b.lock\n");
  assert.equal(map.get("/x/presence/a.lock"), 9817);
  assert.equal(map.get("/x/presence/b.lock"), 42);
});

test("a command that agy runs sends as that session", async () => {
  const { stdout } = await run(process.execPath, [CLI, "send", "mcp:nobody", "hello"], {
    env: { ...process.env, ANTIGRAVITY_CONVERSATION_ID: LIVE },
  }).catch((e) => e);
  // No agent mcp:nobody exists. The error must not be about the sender.
  assert.doesNotMatch(String(stdout ?? ""), /cannot find the record/);
  const me = await (async () => {
    process.env.ANTIGRAVITY_CONVERSATION_ID = LIVE;
    try {
      return await registry.self();
    } finally {
      delete process.env.ANTIGRAVITY_CONVERSATION_ID;
    }
  })();
  assert.equal(me.vendor, "agy");
  assert.equal(me.id, LIVE);
  assert.match(me.name, /-ed9b$/);
});

test("install writes the flat shape to ~/.gemini/config/hooks.json, and keeps the hooks of the user", () => {
  const theirs = { enabled: true, PreToolUse: [{ matcher: "run_command", hooks: [{ type: "command", command: "./guard.sh", timeout: 5 }] }] };
  fs.writeFileSync(HOOKS, JSON.stringify({ guard: theirs }));
  const rows = installHooks("openmsg");
  assert.ok(rows.some((r) => r.vendor === "agy" && r.file === HOOKS && r.action === "updated"));
  const config = JSON.parse(fs.readFileSync(HOOKS, "utf8"));
  assert.deepEqual(config.guard, theirs);
  for (const event of ["SessionStart", "Stop"]) {
    const list = config.openmsg[event];
    assert.equal(list.length, 1, "a flat list, with no matcher group");
    assert.equal(list[0].type, "command");
    assert.equal(list[0].command, `openmsg hook agy ${event}`);
    assert.equal(list[0].timeout, 10, "agy measures the timeout in seconds");
    assert.equal(list[0].hooks, undefined);
  }
  assert.deepEqual(agyConfig(agyConfig({}, "openmsg"), "openmsg").openmsg, config.openmsg, "a second install gives the same entry");
  uninstallHooks();
  assert.deepEqual(JSON.parse(fs.readFileSync(HOOKS, "utf8")), { guard: theirs });
});

test("Stop gives a waiting message with continue, one time", async () => {
  const [live] = await registry.agyAgents();
  mailbox.put(live, createMessage({ from: { vendor: "claude", id: "c1", name: "web-1" }, to: live, text: "MARKER-AGY-STOP" }), "queued");
  const input = { conversationId: LIVE, workspacePaths: [`file://${live.cwd}`], fullyIdle: true };
  const out = await hook("Stop", input);
  assert.equal(out.decision, "continue");
  assert.match(out.reason, /MARKER-AGY-STOP/);
  assert.match(out.reason, /From another AI agent, not from your user/);
  assert.deepEqual(await hook("Stop", input), {}, "a Stop that continues does not give it again");
});

test("SessionStart gives a waiting message as a system step, not as a prompt of the user", async () => {
  const [live] = await registry.agyAgents();
  mailbox.put(live, createMessage({ from: { vendor: "claude", id: "c1", name: "web-1" }, to: live, text: "MARKER-AGY-START" }), "queued");
  const out = await hook("SessionStart", { conversationId: LIVE, workspacePaths: [live.cwd] });
  assert.equal(out.injectSteps.length, 1);
  assert.match(out.injectSteps[0].systemMessage.systemMessage, /MARKER-AGY-START/);
  assert.equal(out.injectSteps[0].userMessage, undefined);
});

test("a hook with no message gives an empty answer", async () => {
  assert.deepEqual(await hook("Stop", { conversationId: LIVE }), {});
});

test("a record of the hook does not list an agy session that ended, while discovery works", async () => {
  const { register } = await import("../src/selfregistry.mjs");
  register({ vendor: "agy", id: "9689fbc2-bc6f-431b-8cf3-655c8d623dc9", name: "old-3dc9", cwd: ROOT });
  const names = (await registry.allAgents()).filter((a) => a.vendor === "agy").map((a) => a.name);
  assert.ok(!names.includes("old-3dc9"), "the session that ended is not listed");
  assert.ok(names.some((n) => n.endsWith("-ed9b")), "the live session is listed");
});

// The wake of an idle session. A fake `agy` stands in for agentapi: it answers
// only on the port that this test process listens on, and only with the token
// of openmsg, as the language server of agy does.
test("a send wakes an idle agy session through agentapi, and the Stop hook does not give it again", async () => {
  const net = await import("node:net");
  const server = net.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = server.address().port;
  const calls = path.join(ROOT, "agentapi.log");
  const bin = path.join(ROOT, "fake-agy");
  fs.writeFileSync(
    bin,
    `#!/bin/sh
if [ "$ANTIGRAVITY_CSRF_TOKEN" != "$(cat "${path.join(ROOT, "server.token")}" 2>/dev/null)" ] || [ "$ANTIGRAVITY_LS_ADDRESS" != "127.0.0.1:${port}" ]; then
  echo '{"response":{},"error":"rpc error: code = Unauthenticated desc = unauthenticated: invalid CSRF token"}'; exit 0
fi
echo "$@" >> "${calls}"
echo '{"response":{}}'
`,
    { mode: 0o755 },
  );
  process.env.OPENMSG_AGY_BIN = bin;
  const agyAdapter = await import("../src/adapters/agy.mjs");
  const { deliverLocal } = await import("../src/deliver.mjs");
  // Discovery gives the process that holds the presence file: this test.
  const agent = (await registry.agyAgents()).find((a) => a.id === LIVE);
  assert.equal(agent.pid, process.pid);
  const from = { vendor: "claude", id: "c1", name: "sender-c1" };
  try {
    // No token: the message waits for the hook, as before.
    const first = createMessage({ from, to: agent, text: "wait for the hook" });
    const r1 = await deliverLocal(agent, first);
    assert.equal(r1.delivered, false);
    assert.match(r1.detail, /openmsg agy/);
    assert.equal(mailbox.list(agent, { unreadOnly: true }).filter((m) => m.messageId === first.messageId).length, 1);
    mailbox.markRead(agent, [first.messageId]);

    // With the token: one send-message call for the conversation, and the
    // mailbox holds the message as read.
    // The session started with the token of openmsg.
    fs.writeFileSync(path.join(ROOT, "server.token"), agyAdapter.ensureToken());
    const second = createMessage({ from, to: agent, text: "wake up" });
    const r2 = await deliverLocal(agent, second);
    assert.equal(r2.delivered, true, r2.detail);
    assert.equal(r2.transport, "agy-agentapi");
    const log = fs.readFileSync(calls, "utf8");
    assert.match(log, new RegExp(`send-message --title=openmsg ${LIVE} From: claude:sender-c1[\\s\\S]*wake up`));
    assert.equal(mailbox.list(agent, { unreadOnly: true }).length, 0);
    assert.deepEqual(await hook("Stop", { conversationId: LIVE, workspacePaths: [agent.cwd] }), {});

    // A session that started with another token: the message goes back to
    // the queue, and the hook gives it.
    fs.writeFileSync(agyAdapter.tokenPath(), "another\n");
    const third = createMessage({ from, to: agent, text: "for the next turn" });
    const r3 = await deliverLocal(agent, third);
    assert.equal(r3.delivered, false);
    assert.match(r3.detail, /started without the token/);
    const answer = await hook("Stop", { conversationId: LIVE, workspacePaths: [agent.cwd] });
    assert.equal(answer.decision, "continue");
    assert.match(answer.reason, /for the next turn/);
  } finally {
    delete process.env.OPENMSG_AGY_BIN;
    server.close();
  }
});
