// The note that an agent writes about its own work. The vendor gives a title
// too, but a title can be old or wrong. The agent knows what it does now.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function file() {
  return path.join(process.env.OPENMSG_HOME ?? path.join(os.homedir(), ".openmsg"), "notes.json");
}

function key(agent) {
  return `${agent.vendor}:${agent.id}`;
}

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8"));
  } catch {
    return {};
  }
}

function writeAll(all) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 1));
  fs.renameSync(tmp, file());
}

export const MAX_LENGTH = 120;

export function set(agent, text) {
  const note = String(text).replace(/\s+/g, " ").trim().slice(0, MAX_LENGTH);
  const all = readAll();
  if (note) all[key(agent)] = { text: note, at: Date.now() };
  else delete all[key(agent)];
  writeAll(all);
  return note || null;
}

export function get(agent) {
  return readAll()[key(agent)]?.text ?? null;
}

// Add the note of each agent. A note of a session that stopped stays on disk,
// because discovery cannot always tell a stopped session from a quiet one.
export function attach(agents) {
  const all = readAll();
  return agents.map((a) => ({ ...a, note: all[key(a)]?.text ?? null }));
}
