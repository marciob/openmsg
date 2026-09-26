// Tests for the socket path of the Codex adapter. A fake daemon listens on a
// Unix socket and speaks WebSocket and JSON-RPC, as the app-server of Codex.
// Run: node --test
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import * as ws from "../src/wsframe.mjs";
import { queueOverSocket } from "../src/adapters/codex.mjs";
import { createMessage, layoutOf, compose, bodyRange } from "../src/envelope.mjs";

// A short directory, because a Unix socket path has a small limit on macOS.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "om-cx-"));
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

// `answer` gives the reply to one request, or undefined for no reply.
function fakeDaemon(name, answer) {
  const socket = path.join(DIR, name);
  const seen = [];
  const server = http.createServer();
  server.on("upgrade", (request, raw) => {
    const conn = ws.handshake(raw, request);
    conn.on("message", (text) => {
      const m = JSON.parse(text);
      seen.push(m);
      if (m.id === undefined) return;
      const reply = answer(m);
      if (reply !== undefined) conn.send(JSON.stringify({ id: m.id, ...reply }));
    });
  });
  return new Promise((resolve) => server.listen(socket, () => resolve({ socket, seen, server })));
}

const initOk = (m) => (m.method === "initialize" ? { result: { userAgent: "fake" } } : undefined);

test("the socket path marks the text of the sender, and only that text", async (t) => {
  const daemon = await fakeDaemon("ok.sock", (m) =>
    initOk(m) ?? { result: { queuedSubmission: { id: "q1" } } });
  t.after(() => daemon.server.close());

  const message = createMessage({ from: { vendor: "claude", name: "alice" }, to: { vendor: "codex", name: "bob" }, text: "olá, the tests fail" });
  const parts = layoutOf(message);
  const text = compose(parts);
  const out = await queueOverSocket("thread-1", text, bodyRange(parts), { socket: daemon.socket });

  assert.equal(out.transport, "codex-socket");
  assert.deepEqual(daemon.seen.map((m) => m.method), ["initialize", "initialized", "thread/queue/add"]);
  const add = daemon.seen[2].params;
  assert.equal(add.threadId, "thread-1");
  assert.equal(add.input[0].text, text, "the model reads the plain text, with no escape");
  const { start, end } = add.input[0].text_elements[0].byteRange;
  assert.equal(Buffer.from(text).subarray(start, end).toString(), "olá, the tests fail", "the range counts bytes, not characters");
});

test("with no daemon, the socket path gives null, so the command line takes over", async () => {
  assert.equal(await queueOverSocket("t", "x", null, { socket: path.join(DIR, "none.sock") }), null);
});

test("an error from the queue gives null, because the queue took nothing", async (t) => {
  const daemon = await fakeDaemon("err.sock", (m) =>
    initOk(m) ?? { error: { code: -32601, message: "method not found" } });
  t.after(() => daemon.server.close());
  assert.equal(await queueOverSocket("t", "x", null, { socket: daemon.socket }), null);
});

test("no answer after the queue request is an error, and never a second delivery", async (t) => {
  const daemon = await fakeDaemon("mute.sock", initOk);
  t.after(() => daemon.server.close());
  await assert.rejects(queueOverSocket("t", "x", null, { socket: daemon.socket, timeoutMs: 300 }), /can be in its queue/);
});

// The example of RFC 6455, section 1.3. With another constant, the relay and
// the gateway still agree with each other, and every other server refuses them.
test("the WebSocket handshake gives the value of RFC 6455", () => {
  let written = "";
  const socket = { write: (t) => { written += t; }, on() {} };
  ws.handshake(socket, { headers: { "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } });
  assert.match(written, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=\r\n/);
});
