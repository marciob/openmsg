// The adapter for the Antigravity CLI (agy). It wakes an idle session.
//
// Each agy process runs a language server on two random ports of 127.0.0.1.
// Its HTTP port takes `agy agentapi send-message <conversation id> <text>`,
// and that call starts a turn in a session that waits for its user. The call
// needs a CSRF token. agy makes a random token at each start, and it gives it
// to no hook. A process that starts with ANTIGRAVITY_SERVER_CSRF_TOKEN uses
// that value. openmsg keeps one token in ~/.openmsg/agy.token, and the user
// starts agy with it (see `openmsg agy`).
//
// A session that started without the token cannot be woken. Its message waits
// in the mailbox, and the Stop hook gives it at the end of the next turn.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";

function root() {
  return process.env.OPENMSG_HOME ?? path.join(os.homedir(), ".openmsg");
}

export function tokenPath() {
  return path.join(root(), "agy.token");
}

export function readToken() {
  try {
    const t = fs.readFileSync(tokenPath(), "utf8").trim();
    return t || null;
  } catch {
    return null;
  }
}

// The token gives control of each agy session that started with it, so only
// the owner of the file can read it.
export function ensureToken() {
  const have = readToken();
  if (have) return have;
  const t = crypto.randomBytes(24).toString("hex");
  fs.mkdirSync(root(), { recursive: true });
  fs.writeFileSync(tokenPath(), t + "\n", { mode: 0o600 });
  return t;
}

// The line for ~/.zshrc or ~/.bashrc. The function gives the token to agy
// alone, and not to each program of the shell.
export function shellLine() {
  return `agy() { ANTIGRAVITY_SERVER_CSRF_TOKEN="$(cat "${tokenPath()}" 2>/dev/null)" command agy "$@"; }`;
}

function run(cmd, args, { env, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

// The ports that the process listens on, in the order that lsof gives.
async function listenPorts(pid) {
  let out = "";
  try {
    ({ stdout: out } = await run("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-F", "n"]));
  } catch (e) {
    out = e.stdout ?? "";
  }
  return out
    .split("\n")
    .filter((l) => l.startsWith("n"))
    .map((l) => l.match(/:(\d+)$/)?.[1])
    .filter(Boolean);
}

// agentapi writes JSON with "response" and "error". The error of an agy that
// started with another token is "invalid CSRF token".
function parse(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return { error: String(stdout).trim() || "no answer" };
  }
}

async function agentapi(port, token, args) {
  const env = { ...process.env, ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${port}`, ANTIGRAVITY_CSRF_TOKEN: token };
  try {
    const { stdout } = await run(process.env.OPENMSG_AGY_BIN ?? "agy", ["agentapi", ...args], { env });
    return parse(stdout);
  } catch (e) {
    return e.stdout ? parse(e.stdout) : { error: e.code === "ENOENT" ? "agy is not on the PATH" : e.message };
  }
}

// The HTTP port is the one where a read of the conversation succeeds. The
// other port speaks gRPC over TLS, and it refuses.
async function findPort(pid, token, conversationId) {
  let last = "the process listens on no port";
  for (const port of await listenPorts(pid)) {
    const r = await agentapi(port, token, ["get-conversation-metadata", conversationId]);
    if (!r.error) return { port };
    last = r.error;
  }
  return { error: last };
}

// The text goes into the conversation as a message to the agent, and agy
// starts a turn for it. The caller marks the message as read in the mailbox,
// so the Stop hook does not give it a second time.
export async function deliver(agent, text) {
  const token = readToken();
  if (!token) return { delivered: false, transport: "mailbox", detail: "no agy token: run openmsg agy" };
  if (!agent.pid) return { delivered: false, transport: "mailbox", detail: "the session has no known process" };
  const found = await findPort(agent.pid, token, agent.id);
  if (found.error) {
    const detail = /CSRF/i.test(found.error)
      ? "this agy session started without the token of openmsg: start agy again with the function of openmsg agy"
      : found.error;
    return { delivered: false, transport: "mailbox", detail };
  }
  const r = await agentapi(found.port, token, ["send-message", "--title=openmsg", agent.id, text]);
  if (r.error) return { delivered: false, transport: "mailbox", detail: r.error };
  return { delivered: true, transport: "agy-agentapi" };
}
