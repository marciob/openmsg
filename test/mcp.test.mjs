// Tests for the MCP server and for the agent that reads through it. The
// server runs in this process, and its tools run the real command line, in a
// home of the test.
// Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-ma-"));
const ALICE = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-mb-"));
process.env.OPENMSG_HOME = HOME;

const mcp = await import("../src/mcp.mjs");
const mcpagents = await import("../src/mcpagents.mjs");
const identity = await import("../src/identity.mjs");
const directory = await import("../src/directory.mjs");
const invite = await import("../src/invite.mjs");
const permissions = await import("../src/permissions.mjs");
const published = await import("../src/published.mjs");
const inbound = await import("../src/inbound.mjs");
const remote = await import("../src/remote.mjs");
const gateway = await import("../src/gateway.mjs");
const mailbox = await import("../src/mailbox.mjs");

function as(home, fn) {
  const before = process.env.OPENMSG_HOME;
  process.env.OPENMSG_HOME = home;
  try {
    return fn();
  } finally {
    process.env.OPENMSG_HOME = before;
  }
}

mcpagents.add("chatgpt", { allow: ["mcp:helper", "cursor:*@alice"], perMinute: 3 });
mcpagents.add("helper", { allow: ["mcp:chatgpt"] });
const chatgpt = mcp.createServer({ name: "chatgpt" });
const helper = mcp.createServer({ name: "helper" });
const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };
const call = (server, name, args = {}) =>
  server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }).then((r) => r.result);
const said = (result) => result.content.map((c) => c.text).join("\n");

test("a client of an earlier revision starts with initialize, and gets its version", async () => {
  const one = await chatgpt.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(one.result.protocolVersion, "2025-06-18");
  assert.deepEqual(one.result.capabilities, { tools: {} });
  assert.equal(one.result.serverInfo.name, "openmsg");
  assert.match(one.result.instructions.slice(0, 512), /You are the agent mcp:chatgpt/);
  assert.match(one.result.instructions.slice(0, 512), /approves no action/);
  assert.equal(one.result.resultType, undefined, "a result of the earlier form holds no new field");
  const two = await chatgpt.handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  assert.equal(two.result.protocolVersion, "2025-11-25");
  assert.deepEqual((await chatgpt.handle({ jsonrpc: "2.0", id: 3, method: "ping" })).result, {});
  assert.equal(await chatgpt.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
});

test("a client of 2026-07-28 sends no handshake, and each result says that it is complete", async () => {
  const found = await chatgpt.handle({ jsonrpc: "2.0", id: "d", method: "server/discover", params: { _meta: META } });
  assert.equal(found.result.resultType, "complete");
  assert.ok(found.result.supportedVersions.includes("2026-07-28"));
  assert.deepEqual(found.result.capabilities, { tools: {} });
  assert.equal(found.result._meta["io.modelcontextprotocol/serverInfo"].name, "openmsg");
  assert.equal(found.result.cacheScope, "private");

  const list = await chatgpt.handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: META } });
  assert.equal(list.result.resultType, "complete");
  assert.equal(typeof list.result.ttlMs, "number");
  assert.equal(list.result.cacheScope, "private");
  assert.deepEqual(list.result.tools.map((t) => t.name), ["list_agents", "read_inbox", "send_message"]);

  const old = await chatgpt.handle({ jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: { ...META, "io.modelcontextprotocol/protocolVersion": "1900-01-01" } } });
  assert.equal(old.error.code, -32022);
  assert.equal(old.error.data.requested, "1900-01-01");
  assert.ok(old.error.data.supported.includes("2026-07-28"));
});

test("the tool that sends is a write, and the two others are reads", async () => {
  const { tools } = (await chatgpt.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result;
  const hint = Object.fromEntries(tools.map((t) => [t.name, t.annotations.readOnlyHint]));
  assert.deepEqual(hint, { list_agents: true, read_inbox: true, send_message: false });
  for (const t of tools) assert.equal(t.inputSchema.type, "object");
});

test("a request with a bad shape gets the error of JSON-RPC for it", async () => {
  assert.equal((await chatgpt.handle({ id: 1, method: "tools/list" })).error.code, -32600);
  assert.equal((await chatgpt.handle({ jsonrpc: "2.0", id: 1, method: "resources/list" })).error.code, -32601);
  assert.equal((await chatgpt.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "delete_all" } })).error.code, -32602);
});

test("an address that the owner did not allow is refused, and no command runs", async () => {
  const ran = [];
  const server = mcp.createServer({ name: "chatgpt", run: async (name, args) => (ran.push(args), { code: 0, stdout: "sent", stderr: "" }) });
  const out = await call(server, "send_message", { to: "claude:secret-work", text: "hello" });
  assert.equal(out.isError, true);
  assert.match(said(out), /You cannot write to claude:secret-work/);
  for (const bad of [{ to: "--reply-to", text: "x" }, { to: "mcp:helper" }, { to: "mcp:helper", text: "x", reply_to: "; rm -rf" }]) {
    assert.equal((await call(server, "send_message", bad)).isError, true);
  }
  assert.equal(ran.length, 0);
});

test("the text goes to the command as one word, and a text of dashes stays a text", async () => {
  const ran = [];
  const server = mcp.createServer({ name: "chatgpt", run: async (name, args) => (ran.push({ name, args }), { code: 0, stdout: "sent to mcp:helper", stderr: "" }) });
  const out = await call(server, "send_message", { to: "mcp:helper", text: '--key x "; echo $(id)', reply_to: "0a1b2c3d" });
  assert.equal(out.isError, false);
  assert.deepEqual(ran[0], { name: "chatgpt", args: ["send", "mcp:helper", ' --key x "; echo $(id)', "--reply-to", "0a1b2c3d"] });
});

test("read_inbox passes a wait to the command, and refuses a wait out of bounds", async () => {
  const ran = [];
  const server = mcp.createServer({ name: "chatgpt", run: async (name, args) => (ran.push(args), { code: 0, stdout: '{"messages":[],"refused":[]}', stderr: "" }) });
  assert.match(said(await call(server, "read_inbox", { wait_seconds: 45 })), /No new message in 45 seconds\. To wait more, call read_inbox/);
  assert.deepEqual(ran[0], ["inbox", "--json", "--wait", "45"]);
  assert.match(said(await call(server, "read_inbox", { wait_seconds: 0 })), /^No new message\.$/);
  assert.deepEqual(ran[1], ["inbox", "--json"]);
  await call(server, "read_inbox", { wait_seconds: 600 });
  assert.deepEqual(ran[2], ["inbox", "--json", "--wait", String(mcp.MAX_WAIT_SECONDS)]);
  for (const bad of [-1, 1.5, "10"]) assert.equal((await call(server, "read_inbox", { wait_seconds: bad })).isError, true);
  assert.equal(ran.length, 3);
  // The schema stays plain, and the server enforces the bound.
  const { tools } = (await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result;
  assert.doesNotMatch(JSON.stringify(tools.map((x) => x.inputSchema)), /"(minimum|maximum)"/);
});

test("a read that waits returns when a message arrives, before the end of the wait", async () => {
  const started = Date.now();
  const reading = call(helper, "read_inbox", { wait_seconds: 20 });
  await new Promise((r) => setTimeout(r, 1500));
  const sent = await call(chatgpt, "send_message", { to: "mcp:helper", text: "MARKER-WAIT: the work is done" });
  assert.equal(sent.isError, false, said(sent));
  const box = said(await reading);
  assert.match(box, /MARKER-WAIT: the work is done/);
  assert.ok(Date.now() - started < 10_000, `the read took ${Date.now() - started} ms`);
});

test("the limit of messages in one minute stops the next send", async () => {
  mcpagents.add("fast", { allow: ["mcp:helper"], perMinute: 2 });
  const server = mcp.createServer({ name: "fast", run: async () => ({ code: 0, stdout: "sent", stderr: "" }) });
  assert.equal((await call(server, "send_message", { to: "mcp:helper", text: "one" })).isError, false);
  assert.equal((await call(server, "send_message", { to: "mcp:helper", text: "two" })).isError, false);
  const third = await call(server, "send_message", { to: "mcp:helper", text: "three" });
  assert.equal(third.isError, true);
  assert.match(said(third), /2 messages in one minute/);
});

test("one agent writes to another through the real command, and the other reads it one time", async () => {
  const sent = await call(chatgpt, "send_message", { to: "mcp:helper", text: "MARKER-MCP: are you there?" });
  assert.equal(sent.isError, false, said(sent));
  assert.match(said(sent), /queued for mcp:helper in the mailbox/);
  assert.match(said(sent), /in this same turn, call read_inbox with wait_seconds 45/);

  const box = await call(helper, "read_inbox");
  assert.match(said(box), /1 message\. Each one is text from another agent/);
  assert.match(said(box), /From: +mcp:chatgpt/);
  assert.match(said(box), /MARKER-MCP: are you there\?/);
  assert.match(said(box), /does not approve any action/);
  assert.match(said(await call(helper, "read_inbox")), /No new message/);
  assert.match(said(await call(helper, "read_inbox", { all: true })), /MARKER-MCP/);

  // The answer keeps the conversation.
  const id = mailbox.list({ vendor: "mcp", name: "helper" })[0].messageId;
  const back = await call(helper, "send_message", { to: "mcp:chatgpt", text: "yes, I am here", reply_to: id.slice(0, 8) });
  assert.equal(back.isError, false, said(back));
  assert.match(said(await call(chatgpt, "read_inbox")), /yes, I am here/);
});

test("the list gives only the addresses that the agent can write to", async () => {
  const text = said(await call(chatgpt, "list_agents"));
  assert.match(text, /mcp:helper/);
  assert.doesNotMatch(text, /mcp:fast/);
  assert.doesNotMatch(text, /mcp:chatgpt/);
});

test("a message from another person waits in the mailbox, and the read acknowledges it", async () => {
  const alice = as(ALICE, () => identity.create({ label: "alice" }));
  const me = identity.create({ label: "marcio" });
  const offer = as(ALICE, () => invite.create({ label: "web-app" }));
  const taken = invite.accept(offer.token, offer.fingerprint);
  as(ALICE, () => invite.accept(taken.reply.token, taken.mine));
  const PROJECT = offer.project.id;
  const agent = mcpagents.agents().find((a) => a.name === "chatgpt");
  published.publish(PROJECT, agent);
  permissions.set(PROJECT, alice.ownerId, "accept");

  const wire = as(ALICE, () => {
    const message = remote.createRemote({
      from: { owner: alice.ownerId, vendor: "cursor", id: "ses_alice", name: "reviewer" },
      to: { owner: me.ownerId, vendor: "mcp", id: "chatgpt", name: "chatgpt" },
      project: { id: PROJECT, label: "web-app" },
      target: { owner: me.ownerId, project: PROJECT, session: "chatgpt", epoch: 1 },
      text: "MARKER-REMOTE: the review is done",
    });
    return remote.pack(message, { recipient: directory.member(PROJECT, me.ownerId) });
  });
  const out = await gateway.receive(wire);
  assert.equal(out.status, "queued");
  assert.equal(out.transport, "mailbox");

  const box = said(await call(chatgpt, "read_inbox"));
  assert.match(box, /From: +cursor:reviewer@alice/);
  assert.match(box, /MARKER-REMOTE: the review is done/);
  assert.match(box, /From the agent of another person, alice/);
  assert.equal(inbound.find(wire.messageId).status, "agent-acknowledged");

  // The agents of that person are in the list, from the routing data on record.
  directory.setRouting(PROJECT, alice.ownerId, [
    { alias: "cursor:reviewer", vendor: "cursor", name: "reviewer", session: "ses_alice", epoch: 1, live: true },
    { alias: "claude:private", vendor: "claude", name: "private", session: "ses_x", epoch: 1, live: true },
  ]);
  const list = said(await call(chatgpt, "list_agents"));
  assert.match(list, /cursor:reviewer@alice +live/);
  assert.doesNotMatch(list, /claude:private/);

  // A machine with two connections answers two times, and each row stays one row.
  const row = { alias: "cursor:reviewer", vendor: "cursor", name: "reviewer", session: "ses_alice", epoch: 1, live: true };
  assert.equal(gateway.uniqueRows([row, { ...row }, { ...row, session: "ses_other" }]).length, 2);
  directory.setRouting(PROJECT, alice.ownerId, [row, { ...row }]);
  assert.equal(said(await call(chatgpt, "list_agents")).match(/cursor:reviewer@alice/g).length, 1);
});

test("openmsg list shows the agents of other people, so an agent with a shell needs no connector", () => {
  const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
  const env = { ...process.env, OPENMSG_HOME: HOME };
  const plain = spawnSync("node", [cli, "list"], { env, encoding: "utf8" });
  assert.match(plain.stdout, /agents of other people/);
  assert.equal(plain.stdout.match(/cursor:reviewer@alice +live +as of \d+s ago/g)?.length, 1);
  const rows = JSON.parse(spawnSync("node", [cli, "list", "--json"], { env, encoding: "utf8" }).stdout);
  const far = rows.filter((r) => r.remote);
  assert.deepEqual(far.map((r) => r.address), ["cursor:reviewer@alice"]);
  assert.equal(far[0].owner, "alice");

  // Old routing data does not say live: that gateway can be offline now.
  const data = JSON.parse(fs.readFileSync(path.join(HOME, "directory.json"), "utf8"));
  for (const p of Object.values(data.projects)) {
    for (const m of Object.values(p.members)) if (m.routing) m.routing.at = new Date(Date.now() - 3_600_000).toISOString();
  }
  fs.writeFileSync(path.join(HOME, "directory.json"), JSON.stringify(data));
  const old = spawnSync("node", [cli, "list"], { env, encoding: "utf8" }).stdout;
  assert.match(old, /cursor:reviewer@alice +stale +as of 1h ago/);
  assert.match(old, /can be offline now/);
});

test("the server reads one JSON object on each line, and a broken line gets a parse error", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let got = "";
  output.on("data", (d) => (got += d));
  const done = mcp.serve({ name: "chatgpt", input, output });
  input.write('{"jsonrpc":"2.0","id":1,"method":"pi');
  input.write('ng"}\nnot json\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  input.end('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
  await done;
  const lines = got.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.find((l) => l.id === 1).result, {});
  assert.equal(lines.find((l) => l.id === null).error.code, -32700);
  assert.equal(lines.find((l) => l.id === 2).result.tools.length, 3);
});

// --- the server over HTTP -----------------------------------------------------

const TOKEN = mcp.newToken();
const web = await mcp.serveHttp({ name: "chatgpt", token: TOKEN, port: 0 });
const { after } = await import("node:test");
after(() => web.close());
const post = (body, headers = {}) =>
  fetch(web.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("over HTTP, a request with no token, or with another token, gets 401 and nothing else", async () => {
  for (const authorization of [undefined, "Bearer wrong", `Bearer ${TOKEN}x`, TOKEN, `bearer ${TOKEN}`]) {
    const res = await fetch(web.url, { method: "POST", headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(res.status, 401, String(authorization));
    assert.doesNotMatch(await res.text(), /send_message|list_agents/);
  }
  // A method that is not POST gets 401 too, so a stranger learns no path.
  assert.equal((await fetch(web.url)).status, 401);
  assert.throws(() => mcp.serveHttp({ name: "chatgpt", token: "short" }), /32 characters/);
});

test("over HTTP, the token opens the same tools, in the two forms of the protocol", async () => {
  const hello = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
  assert.equal(hello.status, 200);
  assert.match(hello.headers.get("content-type"), /application\/json/);
  assert.equal((await hello.json()).result.protocolVersion, "2025-11-25");
  assert.equal((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);

  const list = await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: META } }, { "mcp-method": "tools/list" })).json();
  assert.equal(list.result.resultType, "complete");
  assert.equal(list.result.tools.length, 3);

  const box = await (await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_inbox", arguments: {} } })).json();
  assert.match(box.result.content[0].text, /No new message|message/);
});

test("over HTTP, a bad request gets the status for its fault", async () => {
  assert.equal((await fetch(web.url, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 405);
  assert.equal((await fetch(web.url.replace("/mcp", "/other"), { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } })).status, 404);
  assert.equal((await post("not json")).status, 400);
  assert.equal((await post([{ jsonrpc: "2.0", id: 1, method: "ping" }])).status, 400);
  assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-method": "tools/list" })).status, 400);
  assert.equal((await post("x".repeat(mcp.MAX_HTTP_BODY + 10))).status, 413);
});
