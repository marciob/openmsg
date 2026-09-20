// Discovery: find the agent sessions that run now, for each vendor.
// Each vendor keeps its own record, so openmsg reads each one and returns one list.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { registered } from "./selfregistry.mjs";
import { promisify } from "node:util";

const run = promisify(execFile);
const HOME = os.homedir();

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Claude Code writes one file for each session, with the path of its inbox socket.
export function claudeAgents() {
  const dir = path.join(HOME, ".claude", "sessions");
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    let rec;
    try {
      rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch {
      continue;
    }
    if (!rec.messagingSocketPath || !rec.pid || !alive(rec.pid)) continue;
    out.push({
      vendor: "claude",
      id: rec.sessionId,
      name: rec.name ?? `claude-${rec.pid}`,
      pid: rec.pid,
      cwd: rec.cwd,
      status: rec.status ?? "unknown",
      transport: { kind: "uds", path: rec.messagingSocketPath },
    });
  }
  return out;
}

// OpenCode runs an HTTP server for each user interface. The port is in the
// listening sockets of the process.
export async function opencodeAgents({ maxAgeMs = 24 * 3600 * 1000 } = {}) {
  let pids = [];
  try {
    // `-x` matches the name of the program. `-f` matches the whole command
    // line, and that also matches a program that only holds the word in its
    // environment.
    const { stdout } = await run("pgrep", ["-x", "opencode"]);
    pids = stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
  const found = new Map();
  const out = [];
  for (const pid of pids) {
    let ports = [];
    try {
      const { stdout } = await run("lsof", ["-nP", "-p", pid, "-iTCP", "-sTCP:LISTEN", "-Fn"]);
      ports = [...stdout.matchAll(/n\S*:(\d+)/g)].map((m) => Number(m[1]));
    } catch {
      continue;
    }
    for (const port of new Set(ports)) {
      const base = `http://127.0.0.1:${port}`;
      let sessions;
      try {
        const res = await fetch(`${base}/session`, { signal: AbortSignal.timeout(1500) });
        if (!res.ok) continue;
        sessions = await res.json();
      } catch {
        continue;
      }
      // A session of OpenCode stays on disk after it ends. Only a session that
      // changed a short time ago belongs to the work of now.
      for (const s of sessions) {
        const updated = s.time?.updated ?? 0;
        if (Date.now() - updated > maxAgeMs) continue;
        if (found.has(s.id)) continue;
        found.set(s.id, true);
        const title = (s.title ?? "").trim();
        const short = title && !title.startsWith("New session")
          ? title.slice(0, 32).replace(/\s+/g, "-")
          : s.id.slice(-4);
        out.push({
          vendor: "opencode",
          id: s.id,
          name: `${short}-${s.id.slice(-4)}`,
          pid: Number(pid),
          cwd: s.directory ?? null,
          status: "unknown",
          updatedAt: updated,
          transport: { kind: "http", base },
        });
      }
    }
  }
  return out;
}

// Codex keeps the record of a live session in a rollout file, and the process
// that runs the session holds that file open. openmsg lists the open rollout
// files of every Codex process, and reads the thread id from each one.
export async function codexAgents() {
  let pids = [];
  try {
    const { stdout } = await run("pgrep", ["-x", "codex"]);
    pids = stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
  const found = new Map();
  for (const pid of pids) {
    // A command that an agent runs can be sandboxed. Then `lsof` gives nothing,
    // and the caller falls back to codexAgentsFromFiles().
    let paths = [];
    try {
      const { stdout } = await run("lsof", ["-p", pid, "-Fn"]);
      paths = [...stdout.matchAll(/\/[^\s]*\/\.codex\/sessions\/[^\s]*rollout-[^\s]*\.jsonl/g)].map((m) => m[0]);
    } catch {
      continue;
    }
    for (const file of paths) {
      const id = file.match(/rollout-[\dT-]+-([0-9a-f-]{36})\.jsonl$/)?.[1];
      if (!id || found.has(id)) continue;
      let cwd = null;
      let name = id.slice(-8);
      try {
        const first = fs.readFileSync(file, "utf8").split("\n", 1)[0];
        const meta = JSON.parse(first);
        cwd = meta?.payload?.cwd ?? null;
        if (cwd) name = `${path.basename(cwd)}-${id.slice(-4)}`;
      } catch {
        // The file can be empty while Codex starts. The thread id still works.
      }
      found.set(id, {
        vendor: "codex",
        id,
        name,
        pid: Number(pid),
        cwd,
        status: "unknown",
        transport: { kind: "codex-queue" },
      });
    }
  }
  return [...found.values()];
}

// Fallback for Codex when the command runs in a sandbox that blocks `lsof`.
// It reads the rollout files that Codex changed in the last hours. A file that
// changed a moment ago belongs to a session that runs now.
export function codexAgentsFromFiles({ maxAgeMs = 12 * 3600 * 1000 } = {}) {
  const root = path.join(HOME, ".codex", "sessions");
  const out = [];
  const walk = (dir, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(full, depth + 1);
      else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) {
        let stat;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        if (Date.now() - stat.mtimeMs > maxAgeMs) continue;
        const id = e.name.match(/rollout-[\dT-]+-([0-9a-f-]{36})\.jsonl$/)?.[1];
        if (!id) continue;
        let cwd = null;
        try {
          cwd = JSON.parse(fs.readFileSync(full, "utf8").split("\n", 1)[0])?.payload?.cwd ?? null;
        } catch {
          // An empty file belongs to a session that just started.
        }
        out.push({
          vendor: "codex",
          id,
          name: cwd ? `${path.basename(cwd)}-${id.slice(-4)}` : id.slice(-8),
          pid: null,
          cwd,
          status: "unknown",
          transport: { kind: "codex-queue" },
          mtimeMs: stat.mtimeMs,
        });
      }
    }
  };
  walk(root, 0);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export async function allAgents() {
  const [claude, opencode, codex] = await Promise.all([
    Promise.resolve(claudeAgents()),
    opencodeAgents(),
    codexAgents(),
  ]);
  // An agent with no push entry point reports itself from its hook.
  return [...claude, ...opencode, ...codex, ...registered()];
}

export async function findAgent(query) {
  const agents = await allAgents();
  const [vendor, name] = query.includes(":") ? [query.split(":")[0], query.split(":").slice(1).join(":")] : [null, query];
  const matches = agents.filter(
    (a) => (!vendor || a.vendor === vendor) && (a.name === name || a.id === name || a.id?.startsWith(name)),
  );
  if (matches.length === 0) throw new Error(`no agent matches "${query}". Run: openmsg list`);
  if (matches.length > 1) {
    const names = matches.map((m) => `${m.vendor}:${m.name}`).join(", ");
    throw new Error(`"${query}" matches more than one agent: ${names}`);
  }
  return matches[0];
}

// The agents that run a shell command do not all say who they are. openmsg finds
// the sender in three steps: the environment of Claude Code, then the process
// that started this command, then the OPENMSG_SELF variable.
async function ancestors(pid, depth = 8) {
  const out = [];
  let current = pid;
  for (let i = 0; i < depth && current > 1; i++) {
    out.push(current);
    try {
      const { stdout } = await run("ps", ["-o", "ppid=", "-p", String(current)]);
      current = Number(stdout.trim());
    } catch {
      break;
    }
  }
  return out;
}

export async function self() {
  // OPENMSG_SELF can hold an alias, such as "codex:openmsg-33ce". An alias is
  // not a session id, so openmsg looks the session up. Without this step, a
  // reply that pins the session id of the sender fails.
  if (process.env.OPENMSG_SELF) {
    const value = process.env.OPENMSG_SELF;
    try {
      return await findAgent(value);
    } catch {
      const [vendor, ...rest] = value.split(":");
      const name = rest.join(":");
      return { vendor, id: name, name, unresolved: true };
    }
  }
  // Codex gives the thread id to every command that it runs. This is the exact
  // answer, so openmsg uses it before any guess from the process tree.
  if (process.env.CODEX_THREAD_ID) {
    const id = process.env.CODEX_THREAD_ID;
    const known = codexAgentsFromFiles({ maxAgeMs: 24 * 3600 * 1000 }).find((a) => a.id === id);
    return known ?? { vendor: "codex", id, name: id.slice(-8), transport: { kind: "codex-queue" } };
  }
  if (process.env.CLAUDE_CODE_MESSAGING_SOCKET) {
    const me = claudeAgents().find((a) => a.transport.path === process.env.CLAUDE_CODE_MESSAGING_SOCKET);
    if (me) return me;
  }
  const line = await ancestors(process.ppid);
  let [codex, opencode] = await Promise.all([codexAgents(), opencodeAgents()]);
  if (codex.length === 0) codex = codexAgentsFromFiles({ maxAgeMs: 6 * 3600 * 1000 });

  // Direct match: an agent process is one of the parents of this command.
  for (const pid of line) {
    const byPid = [...codex, ...opencode].filter((a) => a.pid === pid);
    if (byPid.length === 1) return byPid[0];
  }

  // Codex runs a command in a separate process, and the session record stays
  // with the daemon. A Codex process in the parent line still shows the vendor,
  // and the working directory shows the session.
  const names = await Promise.all(
    line.map(async (pid) => {
      try {
        const { stdout } = await run("ps", ["-o", "comm=", "-p", String(pid)]);
        return path.basename(stdout.trim());
      } catch {
        return "";
      }
    }),
  );
  const here = process.cwd();
  // In a sandbox, `ps` can also give nothing. Then the working directory is the
  // only evidence left, so openmsg uses it alone.
  const vendorUnknown = names.every((n) => n === "");
  if (names.includes("codex") || vendorUnknown) {
    const sameDir = codex.filter((a) => a.cwd === here);
    if (sameDir.length === 1) return sameDir[0];
    if (sameDir.length > 1) {
      throw new Error(
        `${sameDir.length} Codex sessions run in this directory, so openmsg cannot tell which one sends. ` +
          `Set OPENMSG_SELF, for example: OPENMSG_SELF=codex:${sameDir[0].name}`,
      );
    }
  }
  if (names.includes("opencode")) {
    const sameDir = opencode.filter((a) => a.cwd === here);
    if (sameDir.length === 1) return sameDir[0];
  }

  return { vendor: "shell", id: String(process.ppid), name: `shell-${process.ppid}` };
}
