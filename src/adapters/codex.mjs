// Adapter: Codex CLI.
// The Codex user interface runs on an app-server. When the shared daemon runs,
// every session connects to it, and a message goes into the queue of a session.
// Codex reads the message at the end of its current turn.
// The daemon must run before the user starts Codex.
//
// The first path is the socket of the daemon: WebSocket over a Unix socket, and
// JSON-RPC inside. It lets the message mark the text of the sender as a text
// element, which Codex draws in its accent color. A text element is only for
// the display: the model reads the text and not the element.
// Source: openai/codex, codex-rs/tui/src/session_queue_commands.rs and
// codex-rs/core/src/session/mod.rs ("UI-only `text_elements`").
// That protocol is internal to Codex. When the socket path fails before the
// message leaves, the adapter uses `codex queue`, which is public.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { render } from "../envelope.mjs";
import * as ws from "../wsframe.mjs";

const run = promisify(execFile);
const RPC_TIMEOUT_MS = 5000;

function socketPath() {
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  return path.join(home, "app-server-control", "app-server-control.sock");
}

export async function deliver(agent, message, { text = null, highlight = null } = {}) {
  const body = text ?? render(message);
  const out = await queueOverSocket(agent.id, body, highlight);
  if (out) return out;
  return queueOverCli(agent.id, body);
}

// It gives null when nothing went into the queue, so the caller can use the
// command line. A failure after the queue request left is an error: the message
// can be in the queue, and a second path would deliver it two times.
export async function queueOverSocket(threadId, text, highlight, { socket = socketPath(), timeoutMs = RPC_TIMEOUT_MS } = {}) {
  let conn;
  try {
    conn = await ws.connect("ws://localhost/rpc", { socketPath: socket, timeoutMs });
  } catch {
    return null;
  }
  const waiting = new Map();
  let next = 0;
  conn.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.id !== undefined && waiting.has(m.id)) waiting.get(m.id)(m);
  });
  conn.on("close", () => { for (const done of waiting.values()) done({ closed: true }); });
  const call = (method, params) => new Promise((resolve) => {
    const id = ++next;
    const timer = setTimeout(() => done({ timeout: true }), timeoutMs);
    const done = (m) => { clearTimeout(timer); waiting.delete(id); resolve(m); };
    waiting.set(id, done);
    conn.send(JSON.stringify({ id, method, params }));
  });

  try {
    const init = await call("initialize", {
      clientInfo: { name: "openmsg", title: null, version: "0.2" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    if (!init.result) return null;
    conn.send(JSON.stringify({ method: "initialized" }));

    const elements = highlight && highlight.end > highlight.start
      ? [{ byteRange: highlight, placeholder: null }]
      : [];
    const out = await call("thread/queue/add", {
      threadId,
      input: [{ type: "text", text, text_elements: elements }],
      clientUserMessageId: randomUUID(),
    });
    // An answer with an error says that the queue took nothing.
    if (out.error) return null;
    if (!out.result) throw new Error(`the codex daemon gave no answer for thread ${threadId}. The message can be in its queue.`);
    const id = out.result.queuedSubmission?.id;
    return { delivered: true, transport: "codex-socket", detail: `Queued message ${id} for thread ${threadId}.` };
  } finally {
    conn.close();
  }
}

async function queueOverCli(threadId, text) {
  try {
    const { stdout } = await run(
      "codex",
      ["queue", "--thread", threadId, "--message", text],
      { timeout: 15000 },
    );
    return { delivered: true, transport: "codex-queue", detail: stdout.trim() };
  } catch (e) {
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || e.message;
    if (out.includes("no rollout found")) {
      throw new Error(`codex thread ${threadId} has no turns yet. Send one prompt in that session first.`);
    }
    throw new Error(`codex queue failed: ${out.slice(0, 300)}`);
  }
}

export async function daemonRunning() {
  try {
    const { stdout } = await run("codex", ["app-server", "daemon", "version"], { timeout: 8000 });
    return JSON.parse(stdout).appServerVersion !== undefined;
  } catch {
    return false;
  }
}

export async function startDaemon() {
  const { stdout } = await run("codex", ["app-server", "daemon", "start"], { timeout: 20000 });
  return JSON.parse(stdout);
}
