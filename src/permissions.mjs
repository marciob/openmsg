// A standing permission for each identity and for each project.
//
// `accept` means that a message goes to the agent. `hold` means that it waits
// for the owner. `refuse` means that it stops at the gateway.
//
// The default is `hold`, also for a person in the directory. Membership of a
// project says who somebody is. It does not say that their agent can write
// into a session of this machine. The owner gives that with one command.
import fs from "node:fs";
import path from "node:path";
import { home } from "./identity.mjs";

export const VALUES = ["accept", "hold", "refuse"];
export const DEFAULT = "hold";

function file() {
  return path.join(home(), "permissions.json");
}

export function read() {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8"));
  } catch {
    return { version: 2, projects: {} };
  }
}

function save(data) {
  const target = file();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1) + "\n");
  fs.renameSync(tmp, target);
}

export function set(projectId, ownerId, value) {
  if (!VALUES.includes(value)) throw new Error(`a permission is ${VALUES.join(", ")}, and not "${value}"`);
  const data = read();
  const project = data.projects[projectId] ?? {};
  project[ownerId] = { value, at: new Date().toISOString() };
  data.projects[projectId] = project;
  save(data);
  return project[ownerId];
}

export function of(projectId, ownerId) {
  return read().projects[projectId]?.[ownerId]?.value ?? DEFAULT;
}

export function list() {
  const out = [];
  for (const [project, owners] of Object.entries(read().projects)) {
    for (const [owner, record] of Object.entries(owners)) out.push({ project, owner, ...record });
  }
  return out;
}
