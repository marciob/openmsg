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
      title: claudeTitle(rec.cwd, rec.sessionId),
      // A program that uses the SDK, such as a memory observer, starts a
      // session too. It is not a session that a person talks to.
      background: rec.entrypoint === "sdk-cli",
      startedAt: rec.startedAt ?? null,
      updatedAt: rec.updatedAt ?? rec.startedAt ?? 0,
      transport: { kind: "uds", path: rec.messagingSocketPath },
    });
  }
  return out;
}

// Claude Code keeps the transcript of a session in a directory that the
// working directory names, with each character that is not a letter or a digit
// changed to "-".
function claudeTranscript(cwd, sessionId) {
  const root = path.join(HOME, ".claude", "projects");
  const file = `${sessionId}.jsonl`;
  if (cwd) {
    const direct = path.join(root, cwd.replace(/[^A-Za-z0-9]/g, "-"), file);
    if (fs.existsSync(direct)) return direct;
  }
  try {
    for (const d of fs.readdirSync(root)) {
      const candidate = path.join(root, d, file);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // No transcripts on this machine.
  }
  return null;
}

function claudeTitle(cwd, sessionId) {
  if (!sessionId) return null;
  const file = claudeTranscript(cwd, sessionId);
  return file ? lastClaudeTitle(file) : null;
}

// Claude Code writes a short title of the conversation into the transcript,
// and it writes it again as the work goes on. A transcript can hold many
// megabytes, so this reads only the end of the file.
export function lastClaudeTitle(file, maxBytes = 1024 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"ai-title"')) continue;
      try {
        const rec = JSON.parse(lines[i]);
        if (rec.type === "ai-title" && rec.aiTitle) return String(rec.aiTitle).trim();
      } catch {
        // The first line of the window can be a part of a line.
      }
    }
  } catch {
    // The transcript is not there yet, or this command cannot read it.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}

// Codex keeps the name of each thread in one index file. A later line for the
// same thread replaces an earlier one.
export function codexTitles(file = path.join(HOME, ".codex", "session_index.jsonl")) {
  const titles = new Map();
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return titles;
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.id && rec.thread_name) titles.set(rec.id, String(rec.thread_name).trim());
    } catch {
      // A line that Codex writes now can be incomplete.
    }
  }
  return titles;
}

// The first line of a rollout file tells where and when the thread started.
function codexMeta(file) {
  try {
    const payload = JSON.parse(fs.readFileSync(file, "utf8").split("\n", 1)[0])?.payload ?? {};
    const started = Date.parse(payload.timestamp ?? "");
    return { cwd: payload.cwd ?? null, startedAt: Number.isNaN(started) ? null : started };
  } catch {
    // The file can be empty while Codex starts.
    return { cwd: null, startedAt: null };
  }
}

function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

// The pids of the programs with this exact name. On macOS, pgrep leaves out
// the parents of its own process, so an agent that runs this command does not
// find itself. `-a` puts them back. Linux pgrep leaves out only itself, and
// there `-a` means another thing.
async function pgrep(name) {
  const args = process.platform === "darwin" ? ["-a", "-x", name] : ["-x", name];
  const { stdout } = await run("pgrep", args);
  return stdout.trim().split("\n").filter(Boolean);
}

// OpenCode runs an HTTP server for each user interface. The port is in the
// listening sockets of the process.
export async function opencodeAgents({ maxAgeMs = 24 * 3600 * 1000 } = {}) {
  let pids = [];
  try {
    // `-x` matches the name of the program. `-f` matches the whole command
    // line, and that also matches a program that only holds the word in its
    // environment.
    pids = await pgrep("opencode");
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
          title: title && !title.startsWith("New session") ? title : null,
          startedAt: s.time?.created ?? null,
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
  let index = null;
  const titles = () => (index ??= codexTitles());
  let pids = [];
  try {
    pids = await pgrep("codex");
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
      // The file can be empty while Codex starts. The thread id still works.
      const { cwd, startedAt } = codexMeta(file);
      found.set(id, {
        vendor: "codex",
        id,
        name: cwd ? `${path.basename(cwd)}-${id.slice(-4)}` : id.slice(-8),
        pid: Number(pid),
        cwd,
        status: "unknown",
        title: titles().get(id) ?? null,
        startedAt,
        updatedAt: mtime(file),
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
  let index = null;
  const titles = () => (index ??= codexTitles());
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
        // An empty file belongs to a session that just started.
        const { cwd, startedAt } = codexMeta(full);
        out.push({
          vendor: "codex",
          id,
          name: cwd ? `${path.basename(cwd)}-${id.slice(-4)}` : id.slice(-8),
          pid: null,
          cwd,
          status: "unknown",
          title: titles().get(id) ?? null,
          startedAt,
          updatedAt: stat.mtimeMs,
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

// Discovery of one vendor. The gateway needs the session of one published
// alias, and discovery of every vendor costs seconds, because it asks the
// operating system for the open sockets of each process.
export async function agentsOfVendor(vendor) {
  if (vendor === "claude") return claudeAgents();
  if (vendor === "opencode") return opencodeAgents();
  if (vendor === "codex") {
    const live = await codexAgents();
    return live.length > 0 ? live : codexAgentsFromFiles();
  }
  return registered();
}

export async function findSession(vendor, id) {
  return (await agentsOfVendor(vendor)).find((a) => a.id === id) ?? null;
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

// The agents that can run a command of their own. Each one is a sender apart
// from the Claude session that started it.
const OTHER_AGENTS = new Set(["codex", "opencode", "cursor-agent"]);

// A program that a Claude session starts, such as an OpenCode server, gets the
// environment of that session, with its socket. That socket names the sender
// only if the session is a parent of this command, and no other agent runs
// between the two. One `ps` call gives the whole tree, so the walk has no
// limit of depth.
export async function runsUnder(sessionPid) {
  let table;
  try {
    const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid=,comm="]);
    table = new Map(
      stdout.trim().split("\n").map((l) => {
        const [pid, ppid, ...comm] = l.trim().split(/\s+/);
        return [Number(pid), { ppid: Number(ppid), name: path.basename(comm.join(" ")) }];
      }),
    );
  } catch {
    table = new Map();
  }
  // In a sandbox, `ps` can give nothing. Then the socket is the only evidence.
  if (!table.has(process.ppid)) return true;
  const seen = new Set();
  for (let pid = process.ppid; pid > 1 && !seen.has(pid); ) {
    if (pid === sessionPid) return true;
    seen.add(pid);
    const p = table.get(pid);
    if (!p || OTHER_AGENTS.has(p.name)) return false;
    pid = p.ppid;
  }
  return false;
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
    if (me && (await runsUnder(me.pid))) return me;
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
