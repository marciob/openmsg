// Adapter: Codex CLI.
// The Codex user interface runs on an app-server. When the shared daemon runs,
// every session connects to it, and `codex queue` puts a message into the queue
// of a session. Codex reads the message at the end of its current turn.
// The daemon must run before the user starts Codex.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { render } from "../envelope.mjs";

const run = promisify(execFile);

export async function deliver(agent, message) {
  try {
    const { stdout } = await run(
      "codex",
      ["queue", "--thread", agent.id, "--message", render(message)],
      { timeout: 15000 },
    );
    return { delivered: true, transport: "codex-queue", detail: stdout.trim() };
  } catch (e) {
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || e.message;
    if (out.includes("no rollout found")) {
      throw new Error(`codex thread ${agent.id} has no turns yet. Send one prompt in that session first.`);
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
