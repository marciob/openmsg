// The agents that read through MCP. Such an agent is a chat product that
// takes a connector, and it has no session and no machine of its own. Its
// owner names it here. A message for it waits in its mailbox, and it reads
// the mailbox with a tool, when its user asks.
//
// `allow` holds the addresses that the agent can write to. The model behind
// the agent reads pages of the web, and a page can try to make it send. The
// list is the bound of what such a send can reach.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function file() {
  return path.join(process.env.OPENMSG_HOME ?? path.join(os.homedir(), ".openmsg"), "mcp.json");
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
  fs.writeFileSync(file(), JSON.stringify(data, null, 1) + "\n");
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
// How many messages one agent sends in one minute, when its owner gives no
// other number.
export const DEFAULT_PER_MINUTE = 10;

export function add(name, { allow = [], perMinute = null } = {}) {
  if (!NAME.test(String(name ?? ""))) {
    throw new Error(`"${name}" is not a name. Use lowercase letters, digits, ".", "_", and "-"`);
  }
  for (const pattern of allow) {
    if (typeof pattern !== "string" || pattern.trim() === "" || /\s/.test(pattern)) {
      throw new Error(`"${pattern}" is not an address. Give an address, or a part of one with "*"`);
    }
  }
  if (perMinute !== null && !(Number.isInteger(perMinute) && perMinute > 0)) {
    throw new Error("the number of messages in one minute is a whole number above 0");
  }
  const data = read();
  const before = data[name];
  data[name] = {
    allow: allow.length > 0 ? allow : (before?.allow ?? []),
    perMinute: perMinute ?? before?.perMinute ?? DEFAULT_PER_MINUTE,
    addedAt: before?.addedAt ?? new Date().toISOString(),
    // A change of the addresses does not change the decision of the owner.
    ...(before?.voice ? { voice: true } : {}),
  };
  save(data);
  return { name, ...data[name] };
}

// The owner can say that one chat is a place where the owner writes. A
// request from that chat then counts as a request of the owner, inside the
// limits that the text of the message gives. Only the owner runs this
// command: no tool of the MCP server reaches it.
export function setVoice(name, on) {
  const data = read();
  if (!data[name]) throw new Error(`no agent mcp:${name}. Run: openmsg mcp add ${name}`);
  if (on) data[name].voice = true;
  else delete data[name].voice;
  save(data);
  return { name, ...data[name] };
}

export function speaksForOwner(agent) {
  return agent?.vendor === "mcp" && !agent.unresolved && read()[agent.name]?.voice === true;
}

// One line for each message that went out with the voice of the owner. The
// owner reads this file to see what a chat asked for in the name of the owner.
function voiceFile() {
  return path.join(path.dirname(file()), "voice.jsonl");
}

export function recordVoice({ from, to, messageId, text }) {
  const line = { at: new Date().toISOString(), from, to, messageId, text };
  fs.mkdirSync(path.dirname(voiceFile()), { recursive: true });
  fs.appendFileSync(voiceFile(), JSON.stringify(line) + "\n", { mode: 0o600 });
}

export function voiceLog() {
  try {
    return fs.readFileSync(voiceFile(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export function remove(name) {
  const data = read();
  if (!data[name]) return false;
  delete data[name];
  save(data);
  return true;
}

export function get(name) {
  const row = read()[name];
  return row ? { name, ...row } : null;
}

// "*" stands for any text. Every other character stands for itself.
export function allows(patterns, address) {
  return patterns.some((pattern) => {
    const shape = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    return new RegExp(`^${shape}$`).test(address);
  });
}

// The same shape that discovery gives for a session of a vendor.
export function agents() {
  return Object.entries(read()).map(([name]) => ({
    vendor: "mcp",
    id: name,
    name,
    pid: null,
    cwd: null,
    status: "reads",
    title: "reads its mailbox through MCP, when its user asks",
    startedAt: null,
    updatedAt: null,
    transport: { kind: "mailbox" },
  }));
}

// The times of the last sends of one agent. The server of one agent can be
// one process for each call, so the count lives in a file.
function sendsFile() {
  return path.join(path.dirname(file()), "mcp-sends.json");
}

export function takeSendSlot(name, { now = Date.now() } = {}) {
  const agent = get(name);
  if (!agent) return { ok: false, why: `no agent mcp:${name}` };
  let all = {};
  try {
    all = JSON.parse(fs.readFileSync(sendsFile(), "utf8"));
  } catch {
    // No send yet.
  }
  const recent = (all[name] ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= agent.perMinute) {
    return { ok: false, why: `the limit is ${agent.perMinute} messages in one minute. Wait, and try again` };
  }
  all[name] = [...recent, now];
  fs.mkdirSync(path.dirname(sendsFile()), { recursive: true });
  fs.writeFileSync(sendsFile(), JSON.stringify(all));
  return { ok: true };
}
