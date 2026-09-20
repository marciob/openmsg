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

// The last routing data that this owner read from that member. A gateway that
// is offline cannot answer, and the epoch in the cache still stops a message
// that would land in a session that took the name later.
export function setRouting(projectId, ownerId, rows, { sealTo = null } = {}) {
  const data = read();
  const record = data.projects[projectId]?.members?.[ownerId];
  if (!record) return null;
  // `sealTo` is the encryption key of the machine that answered. A message
  // that goes to that machine is sealed for it, and not for the owner key.
  record.routing = { at: now(), rows, sealTo };
  save(data);
  return record.routing;
}

export function routingOf(projectId, ownerId) {
  return project(projectId)?.members?.[ownerId]?.routing ?? null;
}

// A machine of a member, and not the member. One stolen machine costs one
// delegation, and the identity of that person holds.
export function revokeDevice(projectId, deviceId, reason = null, { owner = null } = {}) {
  const data = read();
  const entry = data.projects[projectId];
  if (!entry) throw new Error(`no project ${projectId} in the directory`);
  entry.revokedDevices = entry.revokedDevices ?? [];
  if (entry.revokedDevices.some((r) => r.device === deviceId)) return entry.revokedDevices.find((r) => r.device === deviceId);
  // `owner` names the person whose machine it is. That person tells the
  // other members, and no other person speaks for those machines.
  const record = { device: deviceId, owner, at: now(), reason };
  entry.revokedDevices.push(record);
  save(data);
  return record;
}

// An owner that arrived from the relay, and that this person did not accept
// yet. A record never adds a member, and this list is where one waits.
export function putPending(projectId, { ownerId, label, keys, fingerprint }) {
  const data = read();
  const entry = data.projects[projectId];
  if (!entry) return null;
  entry.pending = entry.pending ?? {};
  entry.pending[ownerId] = { ownerId, label, keys, fingerprint, at: entry.pending[ownerId]?.at ?? now() };
  save(data);
  return entry.pending[ownerId];
}

export function pending(projectId = null) {
  const out = [];
  for (const entry of projects()) {
    if (projectId && entry.id !== projectId) continue;
    for (const row of Object.values(entry.pending ?? {})) out.push({ project: entry.id, ...row });
  }
  return out;
}

export function dropPending(projectId, ownerId) {
  const data = read();
  const entry = data.projects[projectId];
  if (!entry?.pending?.[ownerId]) return false;
  delete entry.pending[ownerId];
  save(data);
  return true;
}

export function isDeviceRevoked(projectId, deviceId) {
  return Boolean(project(projectId)?.revokedDevices?.some((r) => r.device === deviceId));
}

export function revokedDevices(projectId) {
  return project(projectId)?.revokedDevices ?? [];
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
