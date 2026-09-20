// The directory holds the members of each project: the owner id, the public
// keys, and the record of a key that the team revoked.
//
// A commit right is not a membership. Only an invitation that a person
// accepted, after a comparison of the fingerprint, writes a member here.
//
// The owner id comes from the keys, so one member never changes its keys. A
// new key is a new owner id, and the old owner id goes to the revoked list.
import fs from "node:fs";
import path from "node:path";
import { home, checkRecord, fingerprint } from "./identity.mjs";

export const VERSION = 2;

function file() {
  return path.join(home(), "directory.json");
}

export function read() {
  try {
    const data = JSON.parse(fs.readFileSync(file(), "utf8"));
    if (!data.projects) data.projects = {};
    return data;
  } catch {
    return { version: VERSION, projects: {} };
  }
}

// One write, or none. A reader never sees half of a directory.
function save(data) {
  const target = file();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1) + "\n");
  fs.renameSync(tmp, target);
  return target;
}

export function projects() {
  return Object.values(read().projects);
}

export function project(id) {
  return read().projects[id] ?? null;
}

// `put` writes one member of one project. It adds the project when the project
// is new. The source says how the member arrived: an invitation, or this owner.
export function put({ id, label }, record, { source = "invite", endpoint = null } = {}) {
  checkRecord(record);
  const data = read();
  const entry = data.projects[id] ?? { id, label: label ?? id, members: {}, revoked: [], joinedAt: now() };
  if (label) entry.label = label;
  const before = entry.members[record.ownerId];
  entry.members[record.ownerId] = {
    ownerId: record.ownerId,
    label: record.label,
    keys: record.keys,
    fingerprint: fingerprint(record),
    // Where the gateway of that owner answers. A member with no endpoint is a
    // member that this machine cannot reach yet.
    endpoint: endpoint ?? before?.endpoint ?? null,
    source,
    addedAt: before?.addedAt ?? now(),
  };
  data.projects[id] = entry;
  save(data);
  return entry.members[record.ownerId];
}

// A revoked owner is not a member. The caller therefore needs no second check
// before it trusts the answer.
export function member(projectId, ownerId) {
  const entry = project(projectId);
  if (!entry) return null;
  if (isRevoked(projectId, ownerId)) return null;
  return entry.members[ownerId] ?? null;
}

export function members(projectId) {
  const entry = project(projectId);
  if (!entry) return [];
  return Object.values(entry.members).filter((m) => !isRevoked(projectId, m.ownerId));
}

export function setEndpoint(projectId, ownerId, endpoint) {
  const data = read();
  const record = data.projects[projectId]?.members?.[ownerId];
  if (!record) throw new Error(`no member ${ownerId} in the project ${projectId}`);
  record.endpoint = endpoint;
  save(data);
  return record;
}

export function isRevoked(projectId, ownerId) {
  const entry = project(projectId);
  return Boolean(entry?.revoked?.some((r) => r.ownerId === ownerId));
}

export function revoked(projectId) {
  return project(projectId)?.revoked ?? [];
}

// The revoked list keeps the keys. A message that arrives later, with a key
// that the team revoked, therefore still finds its record here.
export function revoke(projectId, ownerId, reason = null) {
  const data = read();
  const entry = data.projects[projectId];
  if (!entry) throw new Error(`no project ${projectId} in the directory`);
  const known = entry.members[ownerId];
  if (!known) throw new Error(`no member ${ownerId} in the project ${projectId}`);
  if (entry.revoked.some((r) => r.ownerId === ownerId)) return entry.revoked.find((r) => r.ownerId === ownerId);
  const record = { ownerId, label: known.label, keys: known.keys, at: now(), reason };
  entry.revoked.push(record);
  save(data);
  return record;
}

function now() {
  return new Date().toISOString();
}
