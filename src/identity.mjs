// The identity of one owner, for version 0.2 of the protocol.
//
// An owner holds two keys: one signs a message, and one seals it. The private
// keys stay in `$OPENMSG_HOME/keys`, and they never travel. The public record
// travels, in an invitation and in the directory.
//
// The owner id and the fingerprint both come from the two public keys. A
// record that claims an owner id which its keys do not give is a false record,
// and `checkRecord` refuses it.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { canonical } from "./canonical.mjs";

export const VERSION = 2;

// The home reads from the environment at each call. Two homes on one machine
// therefore work in one process, and a test needs no second computer.
export function home() {
  return process.env.OPENMSG_HOME ?? path.join(os.homedir(), ".openmsg");
}

export function paths() {
  const dir = path.join(home(), "keys");
  return {
    dir,
    signing: path.join(dir, "signing.key"),
    encryption: path.join(dir, "encryption.key"),
    identity: path.join(dir, "identity.json"),
  };
}

export function exists() {
  return fs.existsSync(paths().identity);
}

// A new key loses the history that the old key sealed. The command therefore
// refuses to replace an identity without `force`.
export function create({ label, force = false } = {}) {
  const p = paths();
  if (exists() && !force) {
    throw new Error(
      `an identity is already in ${p.dir}. A new key cannot open what the old key sealed. ` +
        "Use --force to replace it.",
    );
  }
  fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(p.dir, 0o700);
  const signing = crypto.generateKeyPairSync("ed25519");
  const encryption = crypto.generateKeyPairSync("x25519");
  writePrivate(p.signing, signing.privateKey);
  writePrivate(p.encryption, encryption.privateKey);
  const keys = {
    signing: { alg: "Ed25519", x: jwkX(signing.publicKey) },
    encryption: { alg: "X25519", x: jwkX(encryption.publicKey) },
  };
  const record = {
    version: VERSION,
    ownerId: ownerIdOf(keys),
    label: label ?? defaultLabel(),
    keys,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(p.identity, JSON.stringify(record, null, 1) + "\n");
  return record;
}

// The public record of this owner. It is the object that an invitation carries.
export function load() {
  const p = paths();
  if (!exists()) throw new Error(`no identity in ${p.dir}. Run: openmsg id create`);
  const record = JSON.parse(fs.readFileSync(p.identity, "utf8"));
  checkRecord(record);
  return record;
}

export function checkRecord(record) {
  if (!record || typeof record !== "object") throw new Error("an identity record is missing");
  const { keys } = record;
  if (!keys?.signing?.x || !keys?.encryption?.x) throw new Error("an identity record needs both public keys");
  if (keys.signing.alg !== "Ed25519") throw new Error(`unknown signing algorithm: ${keys.signing.alg}`);
  if (keys.encryption.alg !== "X25519") throw new Error(`unknown encryption algorithm: ${keys.encryption.alg}`);
  const owner = ownerIdOf(keys);
  if (record.ownerId !== owner) {
    throw new Error(`the record claims the owner ${record.ownerId}, and its keys give ${owner}`);
  }
  return record;
}

// Both names come from the same digest of the two public keys. The label is
// outside the digest, so a person can rename an owner without a new identity.
function digest(keys) {
  const text = canonical({ encryption: keys.encryption, signing: keys.signing });
  return crypto.createHash("sha256").update(`openmsg-identity-v2\n${text}`).digest("hex");
}

export function ownerIdOf(keys) {
  return `o_${digest(keys).slice(0, 8)}`;
}

// The text that two people read to each other, out of band, before the first
// message. It holds 128 bits of the digest, in eight groups of four.
export function fingerprint(record) {
  return digest(record.keys).slice(0, 32).toUpperCase().match(/.{4}/g).join(" ");
}

export function normalizeFingerprint(text) {
  return String(text ?? "").replace(/[^0-9a-fA-F]/g, "").toUpperCase();
}

export function sameFingerprint(a, b) {
  const one = normalizeFingerprint(a);
  const two = normalizeFingerprint(b);
  return one.length === 32 && one === two;
}

export function publicKeyOf({ alg, x }) {
  return crypto.createPublicKey({ key: { kty: "OKP", crv: alg, x }, format: "jwk" });
}

// A machine that holds a delegation keeps the public record of its owner and
// no private key of that owner. These two give a clear answer there.
function privateKey(file, which) {
  if (!fs.existsSync(file)) {
    throw new Error(
      `this machine holds no ${which} key of the owner. It signs with its own key, ` +
        "and a command that needs the owner key runs on the machine that made the identity.",
    );
  }
  return crypto.createPrivateKey(fs.readFileSync(file, "utf8"));
}

export function hasPrivateKeys() {
  const p = paths();
  return fs.existsSync(p.signing) && fs.existsSync(p.encryption);
}

export function signingKey() {
  return privateKey(paths().signing, "signing");
}

export function encryptionKey() {
  return privateKey(paths().encryption, "encryption");
}

export function sign(bytes) {
  return crypto.sign(null, Buffer.from(bytes), signingKey());
}

export function verifyWith(record, bytes, signature) {
  try {
    return crypto.verify(null, Buffer.from(bytes), publicKeyOf(record.keys.signing), Buffer.from(signature));
  } catch {
    return false;
  }
}

function writePrivate(file, key) {
  fs.writeFileSync(file, key.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function jwkX(key) {
  return key.export({ format: "jwk" }).x;
}

function defaultLabel() {
  try {
    return os.userInfo().username;
  } catch {
    return "owner";
  }
}
