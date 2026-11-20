// A session that openmsg opens, and closes. The owner is away from the
// machine, and a chat of the owner asks for work in a project where no session
// runs. openmsg starts Claude Code there, inside tmux, and the new session is
// an agent like any other: `list` shows it, and `send` reaches it.
//
// tmux gives the session a terminal, so the session runs when the screen is
// locked and no window is open. A window of Terminal.app can show it, and the
// session does not depend on that window.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawn as spawnProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { claudeAgents, claudeConfigDirs } from "./registry.mjs";

const HOME = os.homedir();

// How many sessions that openmsg opened can run at one time.
export const DEFAULT_MAX = 6;
// A session that openmsg opened, with no turn for this many hours, closes.
export const DEFAULT_IDLE_HOURS = 12;

function openmsgHome() {
  return process.env.OPENMSG_HOME ?? path.join(HOME, ".openmsg");
}

function file() {
  return path.join(openmsgHome(), "spawned.json");
}

function read() {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8"));
  } catch {
    return {};
  }
}

function save(data) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1) + "\n");
  fs.renameSync(tmp, file());
}

// A test runs its own tmux server, with its own socket name, so it never
// touches the sessions of the owner.
function tmux(args, opts = {}) {
  const socket = process.env.OPENMSG_TMUX_SOCKET;
  return execFileSync("tmux", [...(socket ? ["-L", socket] : []), ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  }).trim();
}

function tmuxAlive(name) {
  try {
    tmux(["has-session", "-t", `=${name}`]);
    return true;
  } catch {
    return false;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The accounts of Claude Code on this machine. "default" is ~/.claude, and
// each other name is a directory ~/.claude-<name> with sessions in it.
export function accounts() {
  return claudeConfigDirs().map((dir) => ({
    name: dir === path.join(HOME, ".claude") ? "default" : path.basename(dir).replace(/^\.claude-/, ""),
    dir,
  }));
}

export function accountDir(name) {
  const all = accounts();
  const found = all.find((a) => a.name === (name ?? "default"));
  if (!found) {
    throw new Error(`no account "${name}". The accounts on this machine: ${all.map((a) => a.name).join(", ")}`);
  }
  return found;
}

// The account of a folder, when the command names none. The owner keeps the
// rules in ~/.claude/accounts.conf, one line for each rule: a path prefix and
// an account name. The longest prefix that matches wins. The shell of the
// owner reads the same file when the owner types `claude`.
export function accountFor(dir) {
  const conf = process.env.CLAUDE_ACCOUNTS_CONF ?? path.join(HOME, ".claude", "accounts.conf");
  let best = "default";
  let bestLength = 0;
  let lines = [];
  try {
    lines = fs.readFileSync(conf, "utf8").split("\n");
  } catch {
    return best;
  }
  for (const line of lines) {
    const words = line.replace(/#.*/, "").trim().split(/\s+/);
    if (words.length < 2) continue;
    const prefix = words[0].replace(/^~(?=$|\/)/, HOME).replace(/\/+$/, "");
    if ((dir + "/").startsWith(prefix + "/") && prefix.length > bestLength) {
      bestLength = prefix.length;
      best = words[1] === "personal" ? "default" : words[1];
    }
  }
  return best;
}

// Claude Code asks one time for each folder: "Is this a project you trust?"
// The answer is in the state file of the account, for that folder or for a
// folder above it. A session that waits for that answer has no socket yet,
// and no message reaches it.
export function folderTrusted(account, dir) {
  const state = account.name === "default"
    ? path.join(HOME, ".claude.json")
    : path.join(account.dir, ".claude.json");
  let projects = {};
  try {
    projects = JSON.parse(fs.readFileSync(state, "utf8")).projects ?? {};
  } catch {
    return false;
  }
  let at = dir;
  for (;;) {
    if (projects[at]?.hasTrustDialogAccepted) return true;
    const up = path.dirname(at);
    if (up === at) return false;
    at = up;
  }
}

// The names that tell a program that it runs inside a session of an agent.
// The new session is not inside this one, so they do not go to it. The tmux
// server can hold them in its own environment, from the first program that
// started it, so the command removes them each time.
const INHERITED = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CODEX_THREAD_ID",
  "OPENCODE_SESSION_ID",
  "OPENMSG_SELF",
];

// The command that tmux runs. tmux gets each word apart, and no shell reads
// the prompt. `env` replaces itself with claude, so the process id that tmux
// gives is the process id of the session.
export function commandOf({ account, prompt = null, program = "claude" }) {
  const unset = [...new Set([...INHERITED, ...Object.keys(process.env).filter((k) => k.startsWith("CLAUDE_CODE_"))])];
  return [
    "env",
    ...unset.flatMap((k) => ["-u", k]),
    ...(account.name === "default" ? [] : [`CLAUDE_CONFIG_DIR=${account.dir}`]),
    program,
    ...(prompt ? [prompt] : []),
  ];
}

function slug(dir) {
  const base = path.basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
  return base || "session";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function screen(name) {
  try {
    return tmux(["capture-pane", "-p", "-t", `=${name}:`]);
  } catch {
    return "";
  }
}

const TRUST_QUESTION = /trust this folder|Is this a project you created or one you trust/i;

// The sessions that openmsg opened and that still run. A row of a session
// that ended goes away here.
export function running() {
  const data = read();
  let changed = false;
  for (const [name, row] of Object.entries(data)) {
    if (!tmuxAlive(name) && !(row.pid && pidAlive(row.pid))) {
      delete data[name];
      changed = true;
    }
  }
  if (changed) save(data);
  return Object.entries(data).map(([tmuxName, row]) => ({ tmux: tmuxName, ...row }));
}

export function rowOfPid(pid) {
  return running().find((r) => r.pid === pid) ?? null;
}

// Open one session. It gives the record of the new session when discovery
// finds it.
//   dir          the working directory. It must exist.
//   account      a name from accounts(). With null, accounts.conf chooses.
//   prompt       the first message of the session, or null.
//   trustFolder  true when the owner said yes to the question of Claude Code
//                for a folder that the account does not trust yet.
//   view         true opens a window of Terminal.app that shows the session.
//   program      the command. A test gives a program that is not Claude.
//   role         "operator" for the session that a chat of the owner talks to.
//                The limit and the idle rule do not count it.
export async function open({
  dir,
  account: accountName = null,
  prompt = null,
  trustFolder = false,
  view = true,
  program = "claude",
  role = null,
  max = Number(process.env.OPENMSG_SPAWN_MAX ?? DEFAULT_MAX),
  waitMs = 30_000,
  find = (pid) => claudeAgents().find((a) => a.pid === pid) ?? null,
} = {}) {
  if (!dir) throw new Error("give the directory of the new session");
  const where = path.resolve(dir.replace(/^~(?=$|\/)/, HOME));
  if (!fs.existsSync(where) || !fs.statSync(where).isDirectory()) throw new Error(`${where} is not a directory`);
  const real = fs.realpathSync(where);
  const account = accountDir(accountName ?? accountFor(real));

  // The operator is not one of the sessions of the work, so it takes no place.
  const now = running().filter((r) => r.role !== "operator");
  if (now.length >= max) {
    throw new Error(
      `${now.length} sessions that openmsg opened run now, and the limit is ${max}. ` +
        `Close one first: openmsg close <session>. These run: ${now.map((r) => r.address ?? r.tmux).join(", ")}`,
    );
  }
  const trusted = folderTrusted(account, real);
  if (!trusted && !trustFolder) {
    throw new Error(
      `the account ${account.name} does not trust the folder ${real} yet, and Claude Code asks about it before the session starts. ` +
        "That answer is a permission of your user. Ask your user first. " +
        "After a yes, run the same command again with --trust-folder",
    );
  }

  const name = `om-${slug(real)}-${randomBytes(2).toString("hex")}`;
  const pid = Number(
    tmux([
      "new-session", "-d", "-s", name, "-x", "200", "-y", "50", "-c", real,
      "-P", "-F", "#{pane_pid}",
      ...commandOf({ account, prompt, program }),
    ]),
  );
  const row = { pid, dir: real, account: account.name, ...(role ? { role } : {}), startedAt: new Date().toISOString(), address: null, session: null };
  const data = read();
  data[name] = row;
  save(data);

  // The answer to the question of Claude Code about the folder. The second
  // choice is "Yes, I trust this folder".
  let answered = trusted;
  const until = Date.now() + waitMs;
  let agent = null;
  while (Date.now() < until) {
    agent = find(pid);
    if (agent) break;
    if (!tmuxAlive(name)) break;
    if (!answered && TRUST_QUESTION.test(screen(name))) {
      tmux(["send-keys", "-t", `=${name}:`, "Down"]);
      tmux(["send-keys", "-t", `=${name}:`, "Enter"]);
      answered = true;
    }
    await sleep(300);
  }

  if (agent) {
    row.address = `${agent.vendor}:${agent.name}`;
    row.session = agent.id;
    const again = read();
    if (again[name]) {
      again[name] = row;
      save(again);
    }
  }
  const viewed = view && agent ? showWindow(name) : null;
  return { tmux: name, ...row, agent, viewed, alive: tmuxAlive(name) };
}

// A window of Terminal.app that shows the session. The window is only a view:
// the session runs in tmux, and it keeps running when the window closes.
// macOS asks the owner one time to let openmsg control Terminal.app.
export function showWindow(name) {
  const socket = process.env.OPENMSG_TMUX_SOCKET;
  const attach = `exec tmux ${socket ? `-L ${socket} ` : ""}attach -t '=${name}'`;
  const script = `tell application "Terminal" to do script "${attach.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  try {
    const child = spawnProcess("osascript", ["-e", script], { stdio: "ignore", detached: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// The windows of Terminal.app that showed a session that ended. A window
// closes only when its tty is one of `ttys` and no process runs in it, so a
// window of the owner with other work stays.
export function closeWindows(ttys) {
  const list = ttys.map((t) => `"${t.replace(/[^/a-z0-9]/gi, "")}"`).join(", ");
  const script = [
    'tell application "Terminal"',
    "  repeat with w in (get every window)",
    `    if ({${list}} contains (tty of tab 1 of w)) and not (busy of tab 1 of w) then close w`,
    "  end repeat",
    "end tell",
  ].join("\n");
  try {
    execFileSync("osascript", ["-e", script], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// Close one session. `agent` is the record of discovery, or null when the
// session has no record yet. A session that openmsg opened loses its tmux
// session too. The transcript stays, and `claude --resume <id>` opens it again.
export async function close({ agent = null, tmuxName = null, waitMs = 5000 } = {}) {
  const rows = running();
  const row = tmuxName
    ? rows.find((r) => r.tmux === tmuxName)
    : rows.find((r) => (agent?.pid && r.pid === agent.pid) || (agent?.id && r.session === agent.id));
  if (tmuxName && !row) throw new Error(`openmsg opened no session ${tmuxName}, or it ended`);
  const pid = agent?.pid ?? row?.pid ?? null;
  if (!pid && !row) throw new Error("that session has no process on this machine");

  // The terminals that show the session. Their windows close after it.
  let views = [];
  if (row && tmuxAlive(row.tmux)) {
    try {
      views = tmux(["list-clients", "-t", `=${row.tmux}`, "-F", "#{client_tty}"]).split("\n").filter(Boolean);
    } catch {
      // No terminal shows it.
    }
    try {
      tmux(["kill-session", "-t", `=${row.tmux}`]);
    } catch {
      // It ended between the check and the command.
    }
  }
  // tmux gives the process a hangup, and Claude Code takes a moment to stop.
  // A process that still runs after that gets a TERM.
  const until = Date.now() + waitMs;
  while (pid && pidAlive(pid) && Date.now() < until) await sleep(200);
  if (pid && pidAlive(pid)) {
    process.kill(pid, "SIGTERM");
    const later = Date.now() + waitMs;
    while (pidAlive(pid) && Date.now() < later) await sleep(200);
  }
  const stopped = !(pid && pidAlive(pid));
  if (views.length > 0) closeWindows(views);
  if (row && stopped) {
    const data = read();
    delete data[row.tmux];
    save(data);
  }
  return {
    stopped,
    opened: Boolean(row),
    tmux: row?.tmux ?? null,
    dir: row?.dir ?? agent?.cwd ?? null,
    configDir: agent?.configDir ?? (row ? accountDir(row.account).dir : null),
    session: agent?.id ?? row?.session ?? null,
  };
}

// The sessions that openmsg opened and that had no turn for `hours`. A
// session that the owner opened never closes here.
export function idle({ hours = DEFAULT_IDLE_HOURS, now = Date.now(), find = (pid) => claudeAgents().find((a) => a.pid === pid) ?? null } = {}) {
  const out = [];
  for (const row of running()) {
    // The operator waits for the owner, and a long wait is its work.
    if (row.role === "operator") continue;
    const agent = find(row.pid);
    const last = agent ? Number(agent.updatedAt) || Date.parse(row.startedAt) : Date.parse(row.startedAt);
    if (now - last >= hours * 3_600_000) out.push({ row, agent });
  }
  return out;
}

// The command that opens a closed session again, in its own account.
export function resumeCommand({ dir, configDir = null, session }) {
  if (!session) return null;
  const env = configDir && configDir !== path.join(HOME, ".claude") ? `CLAUDE_CONFIG_DIR=${configDir} ` : "";
  return `cd ${JSON.stringify(dir ?? ".")} && ${env}claude --resume ${session}`;
}
