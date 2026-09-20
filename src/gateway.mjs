// The gateway: the one process of an owner that the network reaches.
//
// It does three things:
//
// 1. It answers a signed request for routing data, and it names only the
//    sessions that the owner published.
// 2. It takes a sealed message, it opens it, and it applies the standing
//    permission of the sender.
// 3. It gives an accepted message to the local adapter of 0.1.
//
// A vendor socket, a vendor port, a vendor token, and a working directory stay
// on this machine. They never leave through this server.
//
// Version 0.2 phase 3 uses a direct port between two gateways. Phase 4 adds
// the relay, and then no laptop needs an open port.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalBytes } from "./canonical.mjs";
import * as identity from "./identity.mjs";
import * as directory from "./directory.mjs";
import * as permissions from "./permissions.mjs";
import * as published from "./published.mjs";
import * as inbound from "./inbound.mjs";
import * as remote from "./remote.mjs";
import { agentsOfVendor } from "./registry.mjs";
import { deliverLocal } from "./deliver.mjs";
import * as outbox from "./outbox.mjs";
import * as relaylink from "./relaylink.mjs";
import * as limits from "./limits.mjs";

export const PATHS = {
  message: "/openmsg/v2/message",
  routing: "/openmsg/v2/routing",
  receipt: "/openmsg/v2/receipt",
};
export const MAX_BODY = 256 * 1024;
// A signed request that is older than this window is refused, so a request
// that somebody records cannot work again later.
export const REQUEST_WINDOW_MS = 120_000;

// --- the address of this gateway -----------------------------------------

function settingsFile() {
  return path.join(identity.home(), "gateway.json");
}

export function settings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
  } catch {
    return {};
  }
}

export function saveSettings(next) {
  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = { ...settings(), ...next, updatedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(data, null, 1) + "\n");
  return data;
}

export function endpointFor(host, port) {
  const name = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${name}:${port}`;
}

// --- signatures on a request and on an answer ------------------------------

function signObject(body) {
  const me = identity.load();
  return {
    ...body,
    signature: { alg: "Ed25519", by: me.ownerId, value: identity.sign(canonicalBytes(body)).toString("base64url") },
  };
}

function verifyObject(object, member) {
  const { signature, ...body } = object ?? {};
  if (signature?.alg !== "Ed25519" || !signature.value) return false;
  if (signature.by !== member.ownerId) return false;
  return identity.verifyWith(member, canonicalBytes(body), Buffer.from(signature.value, "base64url"));
}

// --- the server ------------------------------------------------------------

// The live sessions of one vendor, for a short time. Discovery asks the
// operating system for the open sockets of each process, and that work does
// not belong in every request.
const agentCache = new Map();
async function liveAgents(vendor, { maxAgeMs = 5000 } = {}) {
  const held = agentCache.get(vendor);
  if (held && Date.now() - held.at < maxAgeMs) return held.rows;
  const rows = await agentsOfVendor(vendor);
  agentCache.set(vendor, { at: Date.now(), rows });
  return rows;
}

// The two descriptions of section 9.4 of the spec. Presence is for a person,
// and routing data is for a gateway. Neither one carries a working directory,
// a socket path, or a token.
export async function descriptions(projectId) {
  const rows = published.list(projectId);
  const byVendor = new Map();
  for (const vendor of new Set(rows.map((r) => r.vendor))) byVendor.set(vendor, await liveAgents(vendor));
  const presence = [];
  const routing = [];
  const me = identity.load();
  for (const row of rows) {
    const agent = (byVendor.get(row.vendor) ?? []).find((a) => a.id === row.session);
    presence.push({ alias: `${row.alias}@${me.label}`, vendor: row.vendor, status: agent?.status ?? "gone" });
    routing.push({
      alias: row.alias,
      vendor: row.vendor,
      name: row.name,
      owner: me.ownerId,
      project: projectId,
      session: row.session,
      epoch: row.epoch,
      live: Boolean(agent),
    });
  }
  return { presence, routing };
}

async function handleRouting(request) {
  const projectId = request?.project;
  if (!projectId) return { code: 400, body: { error: "the request names no project" } };
  const member = directory.member(projectId, request?.owner);
  if (!member) return { code: 403, body: { error: "you are not a member of this project here" } };
  if (!verifyObject(request, member)) return { code: 403, body: { error: "the signature does not match" } };
  const age = Math.abs(Date.now() - Date.parse(request.at ?? 0));
  if (!(age < REQUEST_WINDOW_MS)) return { code: 403, body: { error: "the request is too old" } };
  const me = identity.load();
  const { presence, routing } = await descriptions(projectId);
  return {
    code: 200,
    body: signObject({
      kind: "routing",
      version: 2,
      owner: me.ownerId,
      label: me.label,
      project: projectId,
      at: new Date().toISOString(),
      endpoint: settings().endpoint ?? null,
      presence,
      routing,
    }),
  };
}

// The whole path of an inbound message: open it, apply the permission, and
// give it to the adapter. Every step writes the state to the durable store.
export async function receive(wire, { deliver = deliverLocal, now = Date.now(), log = () => {}, via = "http" } = {}) {
  let opened;
  try {
    opened = remote.open(wire, { now });
  } catch (e) {
    const reason = e.reason ?? "bad-shape";
    inbound.put({
      messageId: wire?.messageId ?? `unknown-${randomUUID()}`,
      status: reason === "expired" ? "expired" : "refused",
      reason,
      detail: e.message,
      from: wire?.from?.owner ?? null,
      project: wire?.project?.id ?? null,
    });
    log(`refused ${wire?.messageId ?? "a message"}: ${reason}`);
    return { status: "refused", reason, detail: e.message, messageId: wire?.messageId ?? null };
  }

  const { message, verified } = opened;
  const record = {
    messageId: message.messageId,
    contextId: message.contextId,
    project: verified.project,
    from: { owner: verified.owner, label: verified.label, fingerprint: verified.fingerprint, alias: message.openmsg.hops.at(-1) },
    target: { session: message.openmsg.target.session, epoch: message.openmsg.target.epoch },
    expiresAt: message.openmsg.expiresAt,
    digest: remote.digestOf(message),
    via,
    message,
    verified,
  };

  const before = inbound.find(message.messageId);
  if (before && before.from?.owner === verified.owner) {
    // Two messages with one id and one sender, and different content. The
    // receiver keeps the first record, and it refuses the new arrival. A
    // receiver never rewrites the history of a delivery that happened.
    if (before.digest && before.digest !== record.digest) {
      inbound.put({ ...before, status: before.status, reason: "conflict", conflictAt: new Date(now).toISOString() });
      log(`conflict ${message.messageId} from ${verified.owner}: another content under one id`);
      return { status: "refused", reason: "conflict", messageId: message.messageId };
    }
    // A retry carries the same message id and the same content. A message that
    // already reached the agent, or that already waits for the owner, does not
    // arrive a second time. A message that a rule stopped can arrive again,
    // because the reason can pass: a session that ran again, for one.
    // "queued" is not a settled state. The receiver wrote that row before it
    // gave the message to the adapter, and a stop in that moment leaves a
    // doubt. A second copy therefore goes to the agent again: a message that
    // arrives twice is better than a message that nobody sees, and rule 8.7
    // of the spec says that the agent must expect a repeat.
    const settled = ["adapter-accepted", "agent-acknowledged", "replied", "held"];
    if (settled.includes(before.status)) {
      inbound.put({ ...before, status: before.status, reason: "duplicate" });
      log(`duplicate ${message.messageId} from ${verified.owner}: it is already "${before.status}"`);
      return { status: before.status, reason: "duplicate", messageId: message.messageId };
    }
  }

  // The limits of the receiver, and not of the sender.
  const stopped = limits.check(inbound.list(), {
    owner: verified.owner,
    project: verified.project,
    session: record.target.session,
    now,
  });
  if (stopped?.action === "refuse") {
    inbound.put({ ...record, status: "refused", reason: stopped.reason, detail: stopped.detail });
    log(`refused ${message.messageId}: ${stopped.detail}`);
    return { status: "refused", reason: stopped.reason, detail: stopped.detail, messageId: message.messageId };
  }
  if (stopped?.action === "hold") {
    inbound.put({ ...record, status: "held", reason: stopped.reason, detail: stopped.detail });
    log(`held ${message.messageId}: ${stopped.detail}`);
    return { status: "held", reason: stopped.reason, detail: stopped.detail, messageId: message.messageId };
  }

  const standing = permissions.of(verified.project, verified.owner);
  if (standing === "refuse") {
    inbound.put({ ...record, status: "refused", reason: "permission-refuse" });
    log(`refused ${message.messageId} from ${verified.owner}: the owner refuses this sender`);
    return { status: "refused", reason: "permission-refuse", messageId: message.messageId };
  }
  if (standing !== "accept") {
    // The message stays outside the context of the model. No model reads it,
    // and no model writes a summary of it.
    inbound.put({ ...record, status: "held", reason: "permission-hold" });
    log(`held ${message.messageId} from ${verified.label} (${verified.owner}). Run: openmsg held`);
    return { status: "held", reason: "permission-hold", messageId: message.messageId };
  }

  // The message is on the disk before the adapter sees it. The reason says
  // which moment this row belongs to.
  inbound.put({ ...record, status: "queued", reason: "delivering", deliveryStartedAt: new Date(now).toISOString() });
  return release(record, { deliver, now, log });
}

// The last step. The gateway checks the rules again here, because a queue and
// a held message both delay a message after the first check.
export async function release(record, { deliver = deliverLocal, now = Date.now(), log = () => {} } = {}) {
  const stop = (reason, detail) => {
    inbound.put({ ...record, status: reason === "expired" ? "expired" : "refused", reason, detail });
    log(`refused ${record.messageId}: ${detail ?? reason}`);
    return { status: reason === "expired" ? "expired" : "refused", reason, detail, messageId: record.messageId };
  };
  if (directory.isRevoked(record.project, record.from.owner)) {
    return stop("revoked-sender", `the team revoked ${record.from.owner}`);
  }
  if (!(Date.parse(record.expiresAt) > now)) return stop("expired", `the deadline passed at ${record.expiresAt}`);

  const mine = published.find(record.project, { session: record.target.session });
  if (!mine) return stop("not-published", "that session is not published in this project");
  if (record.target.epoch !== mine.epoch) {
    return stop("old-epoch", `the message names epoch ${record.target.epoch}, and the session runs epoch ${mine.epoch}`);
  }
  const agent = (await liveAgents(mine.vendor, { maxAgeMs: 0 })).find((a) => a.id === record.target.session);
  if (!agent) return stop("session-gone", "that session does not run now");

  let result;
  try {
    result = await deliver(agent, record.message, { text: remote.render(record) });
  } catch (e) {
    return stop("adapter-failed", e.message);
  }
  // "adapter-accepted" says that the adapter took the message. Whether the
  // model read it is a separate event, and phase 5 adds it.
  const status = result.delivered ? "adapter-accepted" : "queued";
  inbound.put({ ...record, status, transport: result.transport });
  log(`${status} ${record.messageId} from ${record.from.label} to ${agent.vendor}:${agent.name}`);
  return { status, messageId: record.messageId, transport: result.transport };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("the body is too big"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function serve({ port = 0, host = "127.0.0.1", deliver = deliverLocal, log = () => {} } = {}) {
  const server = http.createServer(async (req, res) => {
    const send = (code, body) => {
      const text = JSON.stringify(body);
      res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      res.end(text);
    };
    try {
      if (req.method !== "POST" || !Object.values(PATHS).includes(req.url)) {
        send(404, { error: "no such path" });
        return;
      }
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        send(400, { error: "the body is not JSON" });
        return;
      }
      if (req.url === PATHS.routing) {
        const answer = await handleRouting(body);
        send(answer.code, answer.body);
        return;
      }
      if (req.url === PATHS.receipt) {
        const answer = handleReceipt(body);
        send(answer.code, answer.body);
        return;
      }
      const out = await receive(body, { deliver, log, via: "http" });
      send(out.status === "refused" ? 403 : 200, out);
    } catch (e) {
      send(500, { error: e.message });
    }
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const real = server.address().port;
      resolve({
        server,
        port: real,
        url: endpointFor(host, real),
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

// A receipt says which state a message reached at the receiver. It carries a
// signature, so a sender knows that the owner of that key wrote it.
function handleReceipt(body) {
  const project = body?.project;
  const member = project ? directory.member(project, body?.owner) : null;
  if (!member) return { code: 403, body: { error: "you are not a member of this project here" } };
  if (!verifyObject(body, member)) return { code: 403, body: { error: "the signature does not match" } };
  if (!inbound.STATES.includes(body.status)) return { code: 400, body: { error: `unknown state "${body.status}"` } };
  const row = outbox.find(body.messageId);
  if (!row) return { code: 404, body: { error: "no such message in the outbox" } };
  if (row.to !== member.ownerId) return { code: 403, body: { error: "that message went to another owner" } };
  outbox.setState(body.messageId, body.status, { reason: body.reason ?? null });
  return { code: 200, body: { ok: true } };
}

// The receiver tells the sender which state the message reached. It uses the
// relay when the message came that way, and the direct address otherwise.
export async function reportState(record, status, { reason = null } = {}) {
  const member = directory.member(record.project, record.from.owner);
  if (!member) return { sent: false, why: "that sender is not a member any more" };
  const body = signObject({
    kind: "receipt",
    version: 2,
    owner: identity.load().ownerId,
    project: record.project,
    messageId: record.messageId,
    status,
    reason,
    at: new Date().toISOString(),
  });
  if (record.via === "relay") {
    const url = settings().relay;
    if (!url) return { sent: false, why: "this owner has no relay" };
    const link = await relaylink.open(url);
    link.ack(record.messageId, record.from.owner, status, reason);
    link.close();
    return { sent: true, how: "relay" };
  }
  if (!member.endpoint) return { sent: false, why: `no address for ${member.label}` };
  await postJson(`${member.endpoint}${PATHS.receipt}`, body, { timeoutMs: 10_000 });
  return { sent: true, how: "http" };
}

// --- the client side -------------------------------------------------------

export function routingRequest(projectId) {
  return signObject({
    kind: "routing-request",
    version: 2,
    owner: identity.load().ownerId,
    project: projectId,
    at: new Date().toISOString(),
    nonce: randomUUID(),
  });
}

// The request and the answer both carry a signature of an owner. The relay
// forwards them, and the relay cannot make one.
export function checkRoutingAnswer(answer, member, projectId) {
  if (!verifyObject(answer, member)) throw new Error(`the answer of ${member.ownerId} carries no valid signature`);
  if (answer.owner !== member.ownerId || answer.project !== projectId) {
    throw new Error("the answer names another owner or another project");
  }
  directory.setRouting(projectId, member.ownerId, answer.routing);
  return answer;
}

export async function routingOf(member, projectId, { timeoutMs = 20_000 } = {}) {
  if (!member.endpoint) {
    throw new Error(`no endpoint for ${member.ownerId}. Run: openmsg dir endpoint ${member.ownerId} <url>`);
  }
  const answer = await postJson(`${member.endpoint}${PATHS.routing}`, routingRequest(projectId), { timeoutMs });
  return checkRoutingAnswer(answer, member, projectId);
}

// The same question, over the relay. The gateway of the other person answers
// only when it is online.
export async function routingOverRelay(link, member, projectId) {
  const answer = await link.routing(member.ownerId, projectId, routingRequest(projectId));
  if (answer.error) throw new Error(`${member.label ?? member.ownerId}: ${answer.error}`);
  if (answer.code && answer.code !== 200) throw new Error(`${member.ownerId} refused: ${answer.body?.error}`);
  return checkRoutingAnswer(answer.body ?? answer, member, projectId);
}

// The gateway holds one connection to the relay of its team. The relay pushes
// a message into it, and the gateway answers with the state that the message
// reached here.
export async function joinRelay(url, { log = () => {}, deliver = deliverLocal } = {}) {
  // Every handler takes the link from its own call. The relay pushes the
  // waiting messages the moment the connection opens, before the caller of
  // keep() holds anything.
  const handlers = {
    onOpen: (link) => log(`relay ${url}: connected as ${link.owner}, ${link.welcome?.waiting ?? 0} waiting`),
    onClose: () => log(`relay ${url}: the connection closed`),
    onError: (e) => log(`relay ${url}: ${e.error}`),
    onDeliver: async ({ wire, from }, link) => {
      const out = await receive(wire, { deliver, log, via: "relay" });
      // The acknowledgement tells the relay to forget the message, and it
      // tells the sender what happened here. A refusal is an answer too, and
      // without it the message waits at the relay for ever.
      link.ack(wire.messageId, from, out.status, out.reason ?? null);
    },
    onReceipt: ({ messageId, status, reason }) => {
      outbox.setState(messageId, status, { reason });
      log(`receipt ${messageId}: ${status}${reason ? ` (${reason})` : ""}`);
    },
    onRoutingRequest: async (frame, link) => {
      const answer = await handleRouting(frame.request ?? {});
      link.connection.send(
        JSON.stringify({ type: "routing-answer", to: frame.from, id: frame.id, code: answer.code, body: answer.body }),
      );
    },
  };
  return relaylink.keep(url, handlers);
}

export async function send(member, wire, { timeoutMs = 30_000 } = {}) {
  return postJson(`${member.endpoint}${PATHS.message}`, wire, { timeoutMs, allowError: true });
}

async function postJson(url, body, { timeoutMs = 5000, allowError = false } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(`the gateway at ${url} did not answer: ${e.message}`);
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`the gateway at ${url} answered ${res.status} with text that is not JSON`);
  }
  if (!res.ok && !allowError) throw new Error(`the gateway at ${url} answered ${res.status}: ${data.error ?? text.slice(0, 200)}`);
  return data;
}
