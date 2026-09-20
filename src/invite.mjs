// An invitation carries the public identity of one owner into the directory of
// another owner, for one project.
//
// The token is signed by the key inside it, so a changed byte fails. A
// signature alone proves nothing about the person, because anybody can make a
// key. The two people therefore compare the fingerprint out of band, by voice
// or in a room, and `accept` refuses a token that does not match.
import crypto from "node:crypto";
import { canonicalBytes } from "./canonical.mjs";
import * as identity from "./identity.mjs";
import * as directory from "./directory.mjs";

const PREFIX = "openmsg-invite-v2";
export const DEFAULT_HOURS = 72;

// The project id is opaque. A git remote URL never travels, because it can
// hold a credential or the name of a private host.
export function newProjectId() {
  return `p_${crypto.randomBytes(8).toString("hex")}`;
}

// `create` makes the token that the first person sends. `accept` makes the
// answer of the second person, with the type "accept", and that answer starts
// no third token.
export function create({ label, projectId, hours = DEFAULT_HOURS, type = "invite", endpoint = null } = {}) {
  const me = identity.load();
  const project = { id: projectId ?? newProjectId(), label: label ?? "project" };
  const body = {
    type,
    version: identity.VERSION,
    project,
    identity: me,
    // The address of the gateway of this owner. The directory of section 1 of
    // the spec holds it, and a message needs it before the relay of phase 4.
    endpoint,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + hours * 3600 * 1000).toISOString(),
  };
  const bytes = canonicalBytes(body);
  const token = [PREFIX, bytes.toString("base64url"), identity.sign(bytes).toString("base64url")].join(".");
  directory.put(project, me, { source: "self", endpoint });
  return { token, body, project, fingerprint: identity.fingerprint(me) };
}

// `open` reads a token and proves that it holds the bytes that its key signed.
// It writes nothing. A person reads the fingerprint from here before the
// accept step.
export function open(token) {
  const parts = String(token ?? "").trim().split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) throw new Error("this text is not an openmsg invitation");
  const bytes = Buffer.from(parts[1], "base64url");
  let body;
  try {
    body = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("the invitation is damaged");
  }
  identity.checkRecord(body.identity);
  if (!identity.verifyWith(body.identity, bytes, Buffer.from(parts[2], "base64url"))) {
    throw new Error("the signature of the invitation does not match its text");
  }
  if (!body.project?.id) throw new Error("the invitation names no project");
  return body;
}

export function accept(token, expected, { now = Date.now(), endpoint = null } = {}) {
  const body = open(token);
  if (!(Date.parse(body.expiresAt) > now)) {
    throw new Error(`the invitation expired at ${body.expiresAt}. Ask for a new one.`);
  }
  const me = identity.load();
  if (body.identity.ownerId === me.ownerId) {
    throw new Error("this invitation holds your own identity");
  }
  const theirs = identity.fingerprint(body.identity);
  const given = identity.normalizeFingerprint(expected);
  if (!given) {
    throw new Error(
      "accept needs the fingerprint that the other person read to you: --fingerprint \"XXXX XXXX ...\". " +
        `The token in your hand holds ${theirs}.`,
    );
  }
  // A part of a fingerprint is not a fingerprint. A short value is a typing
  // fault, and a comparison of a part gives a false confidence.
  if (given.length !== 32) {
    throw new Error(`a fingerprint holds 32 characters, and this one holds ${given.length}. Read all of it again.`);
  }
  if (!identity.sameFingerprint(expected, theirs)) {
    throw new Error(`the fingerprint does not match. The token holds ${theirs}. Do not accept it.`);
  }
  if (directory.isRevoked(body.project.id, body.identity.ownerId)) {
    throw new Error(`the team revoked ${body.identity.ownerId} in this project`);
  }
  const peer = directory.put(body.project, body.identity, { source: body.type, endpoint: body.endpoint ?? null });
  directory.put(body.project, me, { source: "self", endpoint });
  // An invitation gets an answer, and an answer gets none. Two tokens join two
  // people, and the chain stops there.
  const reply = body.type === "invite"
    ? create({ label: body.project.label, projectId: body.project.id, type: "accept", endpoint })
    : null;
  return { peer, project: body.project, reply, mine: identity.fingerprint(me) };
}
