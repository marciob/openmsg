// The sessions that this machine saw, and the directory of each one.
//
// A session ends, and its name ends with it. The directory stays. A message
// for a session that ended goes to its directory, and a message can name a
// directory in place of a session. A session of that directory takes it, now
// or when the next one starts.
//
// Another person never reads a path. The name of a place is the last part of
// the path, and the routing data carries that name alone.
import fs from "node:fs";
import path from "node:path";
import { home } from "./identity.mjs";

// The session id of a target that names a place: "place:<name>".
export const PLACE = "place:";
// A directory with no session for this long is not a place any more.
export const PLACE_AGE_MS = 30 * 24 * 3600 * 1000;
// A session that still runs gets a new time at this interval, and not at
// each discovery.
const TOUCH_MS = 3600 * 1000;

function file() {
  return path.join(home(), "places.json");
}

function read() {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8"));
  } catch {
    return { version: 1, sessions: {} };
  }
}

function save(data) {
  const target = file();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1) + "\n");
  fs.renameSync(tmp, target);
}

export function isPlace(session) {
  return typeof session === "string" && session.startsWith(PLACE);
}

export function nameOfPlace(session) {
  return session.slice(PLACE.length);
}

export function nameOf(dir) {
  return path.basename(dir);
}

function realOf(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return null;
  }
}

// Discovery gives the agents that run now. Each one with a directory goes
// into the record. The file changes only when a session is new, moved, or
// was not written for an hour.
export function remember(agents, { now = Date.now() } = {}) {
  let data = null;
  for (const agent of agents) {
    if (!agent?.id || !agent.cwd || agent.background) continue;
    data ??= read();
    const before = data.sessions[agent.id];
    if (before && before.cwd === agent.cwd && now - Date.parse(before.at) < TOUCH_MS) continue;
    const dir = before?.cwd === agent.cwd ? before.dir : realOf(agent.cwd);
    if (!dir) continue;
    data.sessions[agent.id] = { vendor: agent.vendor, id: agent.id, name: agent.name ?? agent.id, cwd: agent.cwd, dir, at: new Date(now).toISOString() };
    data.changed = true;
  }
  if (!data?.changed) return;
  delete data.changed;
  for (const [id, row] of Object.entries(data.sessions)) {
    if (now - Date.parse(row.at) > PLACE_AGE_MS) delete data.sessions[id];
  }
  save(data);
}

export function ofSession(id) {
  return read().sessions[id] ?? null;
}

// The sessions on record, the newest first.
export function sessions({ allow = () => true, now = Date.now() } = {}) {
  return Object.values(read().sessions)
    .filter((row) => now - Date.parse(row.at) <= PLACE_AGE_MS && allow(row))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

// name -> directory. Two directories can end with the same name. The one
// with the newest session holds the name then.
export function dirs({ allow = () => true, now = Date.now() } = {}) {
  const rows = Object.values(read().sessions)
    .filter((row) => now - Date.parse(row.at) <= PLACE_AGE_MS && allow(row))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const out = new Map();
  for (const row of rows) out.set(nameOf(row.dir), row.dir);
  return out;
}
