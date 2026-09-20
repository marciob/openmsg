// A device key, and the delegation that an owner writes for it.
//
// Without this file, the identity of an owner is one private key, and a
// second machine needs a copy of it. A copy on two machines means that one
// stolen machine ends the identity: the owner revokes the key, every member
// invites the owner again, and no old message opens any more.
//
// With a delegation, each machine holds its own two keys, and the owner key
// signs a short record that says "these keys belong to me, for this project,
// until this date". One stolen machine costs one delegation.
//
// The owner key never leaves the machine that made it. A second machine asks
// with a request, and the first machine answers with a delegation.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { canonical, canonicalBytes } from "./canonical.mjs";
import * as identity from "./identity.mjs";

export const VERSION = 2;
export const DEFAULT_DAYS = 365;
const REQUEST = "openmsg-device-request-v2";
const GRANT = "openmsg-delegation-v2";

export function paths() {
  const dir = path.join(identity.home(), "keys");
  return {
    dir,
    signing: path.join(dir, "device-signing.key"),
    encryption: path.join(dir, "device-encryption.key"),
    record: path.join(dir, "device.json"),
  };
}

export function exists() {
  return fs.existsSync(paths().record);
}

// The device id comes from the two device keys, as the owner id comes from
// the two owner keys. A record that claims another id is false.
export function deviceIdOf(keys) {
  const text = canonical({ encryption: keys.encryption, signing: keys.signing });
  return `d_${crypto.createHash("sha256").update(`openmsg-device-v2\n${text}`).digest("hex").slice(0, 8)}`;
}

export function create({ label, force = false } = {}) {
  const p = paths();
  if (exists() && !force) throw new Error(`this machine already has a device key in ${p.dir}. Use --force to replace it.`);
  fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  const signing = crypto.generateKeyPairSync("ed25519");
  const encryption = crypto.generateKeyPairSync("x25519");
  for (const [file, key] of [[p.signing, signing.privateKey], [p.encryption, encryption.privateKey]]) {
    fs.writeFileSync(file, key.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }
  const keys = {
    signing: { alg: "Ed25519", x: signing.publicKey.export({ format: "jwk" }).x },
    encryption: { alg: "X25519", x: encryption.publicKey.export({ format: "jwk" }).x },
  };
  const record = {
    version: VERSION,
    deviceId: deviceIdOf(keys),
    label: label ?? "device",
    keys,
    createdAt: new Date().toISOString(),
    delegation: null,
  };
  fs.writeFileSync(p.record, JSON.stringify(record, null, 1) + "\n");
  return record;
}

export function load() {
  if (!exists()) throw new Error(`no device key on this machine. Run: openmsg device create`);
  const record = JSON.parse(fs.readFileSync(paths().record, "utf8"));
  if (record.deviceId !== deviceIdOf(record.keys)) {
    throw new Error(`the device record claims ${record.deviceId}, and its keys give ${deviceIdOf(record.keys)}`);
  }
  return record;
}

export function signingKey() {
  return crypto.createPrivateKey(fs.readFileSync(paths().signing, "utf8"));
}

export function encryptionKey() {
  return crypto.createPrivateKey(fs.readFileSync(paths().encryption, "utf8"));
}

export function sign(bytes) {
  return crypto.sign(null, Buffer.from(bytes), signingKey());
}

// The delegation that this machine holds, or null. A message carries it, so
// the receiver verifies the chain without asking anybody.
export function delegation() {
  return exists() ? (load().delegation ?? null) : null;
}

export function saveDelegation(record) {
  const p = paths();
  const mine = load();
  if (record.device !== mine.deviceId) {
    throw new Error(`that delegation is for ${record.device}, and this machine is ${mine.deviceId}`);
  }
  fs.writeFileSync(p.record, JSON.stringify({ ...mine, delegation: record }, null, 1) + "\n");
  return record;
}

// --- signing, for a machine or for an owner --------------------------------

// Everything that an owner signs goes through here: a message, a request for
// routing data, an answer, a receipt, and the hello to a relay. A machine
// with a delegation signs with its own key, and a machine that holds the
// owner key signs with that one.
export function signer({ project = null } = {}) {
  const me = identity.load();
  const held = exists() ? delegation() : null;
  if (!held) {
    return { owner: me, by: me.ownerId, device: null, delegation: null, sign: (bytes) => identity.sign(bytes) };
  }
  const why = verify(held, me, { project });
  if (why) throw new Error(`this machine cannot sign: ${why}`);
  return { owner: me, by: me.ownerId, device: held.device, delegation: held, sign };
}

// It gives null when the object is good, and a sentence when it is not. The
// owner record comes from the directory of the reader, and never from the
// object.
export function verifySignedObject(object, ownerRecord, { project = null, now = Date.now() } = {}) {
  const { signature, ...body } = object ?? {};
  if (signature?.alg !== "Ed25519" || !signature.value) return "the object carries no signature";
  if (signature.by !== ownerRecord.ownerId) return `the signature is by ${signature.by}`;
  const value = Buffer.from(signature.value, "base64url");
  if (!signature.device) {
    return identity.verifyWith(ownerRecord, canonicalBytes(body), value) ? null : "the signature does not match the owner";
  }
  const held = body.delegation;
  if (!held) return "the signature names a machine, and the object carries no delegation";
  if (held.device !== signature.device) return `the signature names ${signature.device}, and the delegation names ${held.device}`;
  const why = verify(held, ownerRecord, { project, now });
  if (why) return why;
  return identity.verifyWith({ keys: held.keys }, canonicalBytes(body), value)
    ? null
    : "the signature does not match the machine";
}

// --- the two tokens --------------------------------------------------------

// A machine asks: "these are my public keys, and this is my name."
export function request() {
  const mine = load();
  const body = { kind: "device-request", version: VERSION, device: mine.deviceId, label: mine.label, keys: mine.keys };
  return `${REQUEST}.${canonicalBytes(body).toString("base64url")}`;
}

export function readRequest(token) {
  const parts = String(token ?? "").trim().split(".");
  if (parts.length !== 2 || parts[0] !== REQUEST) throw new Error("this text is not a device request");
  const body = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  if (body.device !== deviceIdOf(body.keys)) throw new Error("the request claims a device id that its keys do not give");
  return body;
}

// The owner answers. `projects` names the projects that this device may sign
// for, and "all" means every project of this owner.
export function grant(ask, { days = DEFAULT_DAYS, projects = "all" } = {}) {
  const me = identity.load();
  const body = {
    kind: "delegation",
    version: VERSION,
    owner: me.ownerId,
    device: ask.device,
    label: ask.label,
    keys: ask.keys,
    projects,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + days * 24 * 3600 * 1000).toISOString(),
  };
  const record = {
    ...body,
    signature: { alg: "Ed25519", by: me.ownerId, value: identity.sign(canonicalBytes(body)).toString("base64url") },
  };
  return { record, token: `${GRANT}.${Buffer.from(JSON.stringify(record)).toString("base64url")}` };
}

export function readGrant(token) {
  const parts = String(token ?? "").trim().split(".");
  if (parts.length !== 2 || parts[0] !== GRANT) throw new Error("this text is not a delegation");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

// The receiver verifies the delegation against the owner record that its own
// directory holds. A delegation never carries the owner key, because a
// message must not carry the key that proves it.
export function verify(record, ownerRecord, { project = null, now = Date.now() } = {}) {
  if (record?.kind !== "delegation" || record.version !== VERSION) return "the delegation has an unknown shape";
  if (record.owner !== ownerRecord.ownerId) return `the delegation names the owner ${record.owner}`;
  if (record.device !== deviceIdOf(record.keys)) return "the delegation claims a device id that its keys do not give";
  if (record.signature?.by !== record.owner) return "the signature of the delegation is by another owner";
  const { signature, ...body } = record;
  if (!identity.verifyWith(ownerRecord, canonicalBytes(body), Buffer.from(signature.value, "base64url"))) {
    return "the owner did not sign this delegation";
  }
  if (!(Date.parse(record.expiresAt) > now)) return `the delegation ended at ${record.expiresAt}`;
  // The scope of section 5.5: a device signs for the projects that the owner
  // named, and for no other one.
  if (project && record.projects !== "all" && !(record.projects ?? []).includes(project)) {
    return `the delegation does not cover the project ${project}`;
  }
  return null;
}
