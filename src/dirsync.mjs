// The directory on the relay, from section 12.1 of the spec.
//
// Three records, and an owner signs each one about itself:
//
// - `self`: "this is my public record, and my gateway answers here".
// - `roster`: "these are the members that I accepted in this project". The
//   other machines of that same owner apply it, because it is that person
//   trusting that person. Nobody else applies it.
// - `revoke-device`: "this machine of mine is gone". Everybody applies it,
//   because only an owner says which machines belong to that owner.
//
// A record carries the public keys of its owner, and the owner id comes from
// those keys. A record is therefore self-verifying, and the relay stores it
// without a directory of its own.
//
// A record never adds a member. A person joins a project through an
// invitation and a fingerprint, as rule 3.3 says. An owner that this machine
// does not know waits in a list, with its fingerprint, for the person to
// accept it.
import { canonicalBytes } from "./canonical.mjs";
import * as identity from "./identity.mjs";
import * as device from "./device.mjs";
import * as directory from "./directory.mjs";
import { settings } from "./settings.mjs";

export const KINDS = ["self", "roster", "revoke-device"];
export const MAX_RECORD_BYTES = 16 * 1024;

function sign(body) {
  const signer = device.signer({ project: body.project });
  const full = signer.delegation ? { ...body, delegation: signer.delegation } : body;
  return {
    ...full,
    signature: {
      alg: "Ed25519",
      by: signer.by,
      device: signer.device,
      value: signer.sign(canonicalBytes(full)).toString("base64url"),
    },
  };
}

export function selfRecord(project) {
  const me = identity.load();
  return sign({
    kind: "self",
    version: 2,
    project,
    owner: me.ownerId,
    label: me.label,
    keys: me.keys,
    endpoint: settings().endpoint ?? null,
    at: new Date().toISOString(),
  });
}

// The members that this owner accepted, with the fingerprint that the person
// compared. Another machine of the same owner takes this list as it is.
export function rosterRecord(project) {
  const me = identity.load();
  const members = directory
    .members(project)
    .filter((m) => m.ownerId !== me.ownerId)
    .map((m) => ({
      ownerId: m.ownerId,
      label: m.label,
      keys: m.keys,
      fingerprint: m.fingerprint,
      endpoint: m.endpoint ?? null,
    }));
  return sign({
    kind: "roster",
    version: 2,
    project,
    // The short name that the team chose. A machine that learns a project
    // from this record shows that name, and not the opaque id.
    label: directory.project(project)?.label ?? null,
    owner: me.ownerId,
    keys: me.keys,
    members,
    at: new Date().toISOString(),
  });
}

export function revokeDeviceRecord(project, deviceId, reason = null) {
  const me = identity.load();
  return sign({
    kind: "revoke-device",
    version: 2,
    project,
    owner: me.ownerId,
    keys: me.keys,
    device: deviceId,
    reason,
    at: new Date().toISOString(),
  });
}

// It gives null when the record is good, and a sentence when it is not.
export function verifyRecord(record) {
  if (!KINDS.includes(record?.kind)) return `unknown record "${record?.kind}"`;
  if (record.version !== 2) return "unknown version";
  if (!record.project || !record.owner || !record.keys?.signing?.x) return "the record is not complete";
  if (record.owner !== identity.ownerIdOf(record.keys)) return "the record claims an owner that its keys do not give";
  if (!Date.parse(record.at)) return "the record has no time";
  return device.verifySignedObject(record, { ownerId: record.owner, keys: record.keys }, { project: record.project });
}

// The reader applies what it may apply, and it lists the rest.
export function apply(project, records, { now = Date.now() } = {}) {
  const me = identity.load();
  const out = { updated: [], added: [], revoked: [], pending: [], refused: [] };
  for (const record of records) {
    const why = verifyRecord(record);
    if (why) {
      out.refused.push({ owner: record?.owner ?? "unknown", why });
      continue;
    }
    if (record.project !== project) {
      out.refused.push({ owner: record.owner, why: "that record belongs to another project" });
      continue;
    }
    if (record.kind === "revoke-device") {
      // Only an owner says which machines belong to that owner.
      if (!directory.isDeviceRevoked(project, record.device)) {
        directory.revokeDevice(project, record.device, record.reason ?? `${record.owner} revoked it`, { owner: record.owner });
        out.revoked.push({ owner: record.owner, device: record.device });
      }
      continue;
    }
    if (record.kind === "self") {
      if (record.owner === me.ownerId) continue;
      const known = directory.member(project, record.owner);
      if (!known) {
        const row = {
          ownerId: record.owner,
          label: record.label,
          keys: record.keys,
          fingerprint: identity.fingerprint(record),
        };
        directory.putPending(project, row);
        out.pending.push(row);
        continue;
      }
      // The keys of an owner never change, because the owner id comes from
      // them. Only the address of the gateway changes here.
      if (record.endpoint && record.endpoint !== known.endpoint) {
        directory.setEndpoint(project, record.owner, record.endpoint);
        out.updated.push({ owner: record.owner, endpoint: record.endpoint });
      }
      continue;
    }
    // A roster of this owner, from another machine of this owner.
    if (record.owner !== me.ownerId) continue;
    // A machine that learns a project from a roster belongs to that project
    // too, so its own record goes in with the others.
    if (!directory.member(record.project, me.ownerId)) {
      directory.put({ id: record.project, label: record.label ?? record.project }, me, { source: "self" });
    }
    for (const member of record.members ?? []) {
      if (identity.ownerIdOf(member.keys) !== member.ownerId) continue;
      if (directory.isRevoked(project, member.ownerId)) continue;
      const known = directory.member(project, member.ownerId);
      if (known) {
        if (member.endpoint && member.endpoint !== known.endpoint) {
          directory.setEndpoint(project, member.ownerId, member.endpoint);
          out.updated.push({ owner: member.ownerId, endpoint: member.endpoint });
        }
        continue;
      }
      directory.put({ id: project, label: record.label ?? project }, {
        version: 2,
        ownerId: member.ownerId,
        label: member.label,
        keys: member.keys,
        createdAt: record.at,
      }, { source: "roster", endpoint: member.endpoint ?? null });
      out.added.push({ owner: member.ownerId, label: member.label });
    }
  }
  return out;
}

// What this machine publishes for one project.
// The person compared the fingerprint, and the owner becomes a member.
export function acceptPending(project, ownerId, fingerprint) {
  const row = directory.pending(project).find((r) => r.ownerId === ownerId || r.ownerId.startsWith(ownerId));
  if (!row) throw new Error(`no owner ${ownerId} waits in ${project}`);
  if (!identity.sameFingerprint(fingerprint, row.fingerprint)) {
    throw new Error(`the fingerprint does not match. The record holds ${row.fingerprint}. Do not accept it.`);
  }
  const record = { version: 2, ownerId: row.ownerId, label: row.label, keys: row.keys, createdAt: row.at };
  directory.put({ id: project }, record, { source: "relay" });
  directory.dropPending(project, row.ownerId);
  return record;
}

export function mine(project) {
  const records = [selfRecord(project), rosterRecord(project)];
  const me = identity.load().ownerId;
  for (const row of directory.revokedDevices(project)) {
    if (row.owner === me) records.push(revokeDeviceRecord(project, row.device, row.reason));
  }
  return records;
}
