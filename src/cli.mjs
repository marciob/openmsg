#!/usr/bin/env node
// openmsg: send a message from one AI coding agent to another.
import { allAgents, findAgent, self } from "./registry.mjs";
import { createMessage, address, MAX_HOPS } from "./envelope.mjs";
import * as mailbox from "./mailbox.mjs";
import { runHook } from "./hook.mjs";
import { installHooks, uninstallHooks } from "./hookinstall.mjs";
import { installGlobal, installProject, uninstall, GLOBAL_TARGETS, PROJECT_FILES } from "./install.mjs";
import * as identity from "./identity.mjs";
import * as directory from "./directory.mjs";
import * as invite from "./invite.mjs";
import * as gateway from "./gateway.mjs";
import * as published from "./published.mjs";
import * as permissions from "./permissions.mjs";
import * as inbound from "./inbound.mjs";
import * as remote from "./remote.mjs";
import { deliverLocal } from "./deliver.mjs";
import * as relay from "./relay.mjs";
import * as relaylink from "./relaylink.mjs";
import * as outbox from "./outbox.mjs";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const USAGE = `openmsg — messages between AI coding agents

  openmsg list                      show the agents that run now
  openmsg send <agent> <text>       send a message to an agent
     [--reply-to <message-id>]      keep the conversation of that message
  openmsg inbox [--json] [--all]    show the messages for this agent
  openmsg whoami                    show how this agent is addressed
  openmsg hook <vendor>             run inside a hook of cursor or gemini
  openmsg install                   let every agent on this machine answer messages
  openmsg install --hooks           add the hook for cursor and gemini
  openmsg install --project [dir]   the same, for one project only
  openmsg uninstall [--project]     remove what install wrote

For the agents of another person (version 0.2, in progress):

  openmsg id create [--label <n>]   make the signing key and the sealing key
  openmsg id show [--json]          show the owner id and the fingerprint
  openmsg invite create             make a token that invites one person
     [--project <label>] [--project-id <id>] [--hours <n>]
  openmsg invite show <token>       read a token, and write nothing
  openmsg invite accept <token> --fingerprint "<value>"
  openmsg dir list [--json]         the members of each project
  openmsg dir endpoint <owner> <url>  where the gateway of that owner answers
  openmsg dir revoke <project-id> <owner-id> [--reason <text>]
  openmsg gateway start [--port <n>] [--host <h>]
  openmsg publish <agent>           let the project reach this session
  openmsg unpublish <alias>         take a session back
  openmsg permit <owner> <accept|hold|refuse>
  openmsg held [<id>] [--text]      the messages that wait for you
  openmsg accept <id> [--always]    give a held message to the agent
  openmsg relay start [--port <n>]  run the relay of a team
  openmsg relay use <url>           send through that relay
  openmsg outbox [--all]            the messages that wait for a receipt

A message to another person goes to "claude:api-worker@alice".

Addresses look like "claude:api-worker" or "opencode:ses_123".
`;

async function cmdList() {
  const agents = await allAgents();
  if (agents.length === 0) {
    console.log("no running agents found");
    return;
  }
  const width = Math.max(...agents.map((a) => address(a).length));
  for (const a of agents) {
    const where = a.cwd ? ` · ${a.cwd}` : "";
    const note = a.note ? ` · ${a.note}` : "";
    console.log(`${address(a).padEnd(width)}  ${a.status}${where}${note}`);
  }
}

async function cmdSend(target, text, replyTo = null, args = []) {
  if (!target || !text) throw new Error('usage: openmsg send <agent> "<text>" [--reply-to <message-id>]');
  // An alias with an owner, such as "claude:api-worker@alice", belongs to
  // another person. That message goes through the two gateways.
  if (target.includes("@")) return cmdSendRemote(target, text, replyTo, args);
  const from = await self();
  // A reply keeps the conversation of the message that it answers, and it adds
  // this agent to the chain of hops.
  const answered = replyTo ? mailbox.find(from, replyTo) : null;
  if (replyTo && !answered) throw new Error(`no message ${replyTo} in the mailbox of ${address(from)}`);

  // A name can move to another session. A reply therefore goes to the session
  // id of the message that it answers, and never to a session that took the
  // name later.
  const pinned = answered?.openmsg?.from?.id ?? null;
  let to;
  try {
    to = await findAgent(pinned ?? target);
  } catch (e) {
    if (!pinned) throw e;
    throw new Error(
      `the session that sent ${replyTo} is gone, so the reply has no target. ` +
        `Its name was ${address(answered.openmsg.from)}. Send a new message instead of a reply.`,
    );
  }
  if (pinned && to.id !== pinned) {
    throw new Error(
      `the session that sent ${replyTo} is gone. Its name now belongs to ${address(to)}. ` +
        "Send a new message instead of a reply.",
    );
  }
  const message = createMessage({
    from,
    to,
    text,
    contextId: answered?.contextId,
    replyTo: replyTo ?? null,
  });
  message.openmsg.hops = [...(answered?.openmsg?.hops ?? []), address(from)];
  if (message.openmsg.hops.length > MAX_HOPS) {
    throw new Error(
      `hop limit reached: this conversation already passed through ${message.openmsg.hops.length - 1} agents. ` +
        "Tell your user instead.",
    );
  }

  const result = await deliverLocal(to, message);

  // "delivered" means an adapter pushed the message into the live session.
  // "queued" means it waits in the mailbox for an agent that reads it at the
  // end of a turn.
  mailbox.put(to, message, result.delivered ? "delivered" : "queued");
  const how = result.delivered
    ? `sent to ${address(to)} over ${result.transport}`
    : `queued for ${address(to)} in the mailbox. That agent reads it at the end of its next turn`;
  console.log(`${how} (${message.messageId})`);
}

async function cmdInbox(args) {
  const me = await self();
  const all = mailbox.list(me, { unreadOnly: !args.includes("--all") });
  // The sender refuses a long chain, but a sender that does not follow this
  // spec can still write to the mailbox. The reader refuses it again.
  const limit = (r) => (r.openmsg?.hops?.length ?? 0) <= MAX_HOPS;
  const rows = all.filter(limit);
  const refused = all.filter((r) => !limit(r)).map((r) => ({
    messageId: r.messageId,
    from: r.openmsg?.from ? address(r.openmsg.from) : "unknown",
    hops: r.openmsg?.hops?.length ?? 0,
    reason: `more than ${MAX_HOPS} hops`,
  }));

  // Everything goes to stdout. A hook that reads stdout alone must still learn
  // that openmsg refused a message.
  if (args.includes("--json")) {
    console.log(JSON.stringify({ messages: rows, refused }, null, 2));
  } else {
    for (const r of refused) {
      console.log(`refused ${r.messageId} from ${r.from}: ${r.reason}`);
    }
    if (rows.length === 0) {
      console.log("no messages");
    } else {
      for (const r of rows) {
        console.log(`from ${address(r.openmsg.from)} at ${r.createdAt}\n${r.parts.map((p) => p.text).join("\n")}\n`);
      }
    }
  }
  mailbox.markRead(me, rows.map((r) => r.messageId));
}

// --- version 0.2: identity, invitations, and the directory ----------------

// A project id, from the flag or from the directory. One project needs no
// flag, and more than one project needs the name.
function projectId(args) {
  const named = flag(args, "project");
  if (named) {
    const known = directory.project(named) ?? directory.projects().find((p) => p.label === named);
    if (!known) throw new Error(`no project "${named}" in the directory`);
    return known.id;
  }
  const all = directory.projects();
  if (all.length === 1) return all[0].id;
  if (all.length === 0) throw new Error("no project in the directory. Run: openmsg invite create");
  throw new Error(`${all.length} projects: ${all.map((p) => `${p.id} (${p.label})`).join(", ")}. Add --project <id>`);
}

// An owner, by the owner id, by the first characters of it, or by the label.
function memberOf(project, query) {
  const rows = directory.members(project);
  const matches = rows.filter((m) => m.ownerId === query || m.ownerId.startsWith(query) || m.label === query);
  if (matches.length === 0) throw new Error(`no member "${query}" in ${project}. Run: openmsg dir list`);
  if (matches.length > 1) throw new Error(`"${query}" names ${matches.length} members. Use the owner id.`);
  return matches[0];
}

async function cmdSendRemote(target, text, replyTo, args) {
  const [alias, ownerName] = [target.slice(0, target.lastIndexOf("@")), target.slice(target.lastIndexOf("@") + 1)];
  const project = projectId(args);
  const member = memberOf(project, ownerName);
  const me = identity.load();

  // A reply keeps the conversation of the message that it answers. That
  // message is in the store of messages that arrived from other people.
  const answered = replyTo ? inbound.findByPrefix(replyTo) : null;
  if (replyTo && !answered) throw new Error(`no message ${replyTo} arrived from another person`);

  // A member with a direct address takes the message over HTTP. A member with
  // no address takes it through the relay of the team.
  const relayUrl = gateway.settings().relay;
  const direct = Boolean(member.endpoint);
  if (!direct && !relayUrl) {
    throw new Error(
      `no way to reach ${member.label}: no endpoint, and no relay. ` +
        "Run: openmsg relay use <url>, or: openmsg dir endpoint <owner> <url>",
    );
  }
  const receipts = [];
  const link = direct ? null : await relaylink.open(relayUrl, { onReceipt: (frame) => receipts.push(frame) });

  let rows;
  let label = member.label;
  try {
    const answer = direct
      ? await gateway.routingOf(member, project)
      : await gateway.routingOverRelay(link, member, project);
    rows = answer.routing;
    label = answer.label ?? label;
  } catch (e) {
    // The gateway of the other person is offline. The routing data that this
    // machine read before still names the session and the epoch, and a
    // session that moved refuses the message by the epoch.
    const cached = directory.routingOf(project, member.ownerId);
    if (!cached) {
      link?.close();
      throw new Error(`${e.message}. This machine holds no routing data for ${member.label} either.`);
    }
    console.error(`openmsg: ${e.message}`);
    console.error(`openmsg: using the routing data of ${cached.at}`);
    rows = cached.rows;
  }

  const row = rows.find((r) => r.alias === alias || r.name === alias || r.session === alias);
  if (!row) {
    link?.close();
    const names = rows.map((r) => `${r.alias}@${label}`).join(", ") || "nothing";
    throw new Error(`${member.label} does not publish "${alias}" in this project. Published: ${names}`);
  }
  if (row.live === false) console.error(`openmsg: the session ${row.alias}@${label} does not run now`);

  const mine = await self();
  const message = remote.createRemote({
    from: { owner: me.ownerId, vendor: mine.vendor, id: mine.id, name: mine.name ?? mine.id },
    to: { owner: member.ownerId, vendor: row.vendor, id: row.session, name: row.name },
    project: { id: project, label: directory.project(project)?.label ?? null },
    target: { owner: member.ownerId, project, session: row.session, epoch: row.epoch },
    text,
    contextId: answered?.message?.contextId ?? null,
    replyTo: answered?.messageId ?? null,
    hops: answered?.message?.openmsg?.hops ?? [],
    workspace: remote.workspaceOf(),
  });
  const wire = remote.pack(message, { recipient: member });
  const how = {
    "adapter-accepted": `reached the agent of ${member.label}`,
    held: `waits for ${member.label} to accept you`,
    queued: `waits in the mailbox of ${member.label}`,
    "relay-holds": `the relay holds it for ${member.label}, who is offline now`,
  };
  let out;
  if (direct) {
    out = await gateway.send(member, wire);
  } else {
    // The sender keeps its copy until a receipt arrives. The relay keeps its
    // own copy at the same time.
    outbox.put({ messageId: message.messageId, to: member.ownerId, project, alias: `${alias}@${label}`, wire, state: "sending" });
    const answer = await link.send(wire);
    if (answer.type !== "stored") {
      outbox.setState(message.messageId, "refused", { reason: answer.reason });
      link.close();
      console.log(`refused by the relay: ${answer.reason} (${message.messageId})`);
      process.exitCode = 1;
      return;
    }
    outbox.setState(message.messageId, "queued");
    // A receipt says what happened at the other end. It can arrive in a
    // moment, or days later, and then the gateway of this owner takes it.
    const receipt = await waitForReceipt(receipts, message.messageId, 3000);
    link.close();
    if (receipt) {
      outbox.setState(message.messageId, receipt.status, { reason: receipt.reason ?? null });
      out = { status: receipt.status, reason: receipt.reason };
    } else {
      out = { status: "relay-holds" };
    }
  }
  console.log(`${how[out.status] ?? `${out.status}${out.reason ? `: ${out.reason}` : ""}`} (${message.messageId})`);
  if (out.status === "refused") process.exitCode = 1;
}

function waitForReceipt(receipts, messageId, ms) {
  return new Promise((resolve) => {
    const started = Date.now();
    const look = () => {
      const found = receipts.find((r) => r.messageId === messageId);
      if (found) return resolve(found);
      if (Date.now() - started > ms) return resolve(null);
      setTimeout(look, 50);
    };
    look();
  });
}

async function cmdRelay(args) {
  const [sub, ...rest] = args;
  if (sub === "start") {
    const host = flag(rest, "host") ?? "127.0.0.1";
    const port = Number(flag(rest, "port") ?? 7800);
    const running = await relay.serve({ port, host, log: (line) => console.log(`${new Date().toISOString()} ${line}`) });
    console.log(`relay listens on ${running.url}, store in ${relay.home()}`);
    console.log("It carries sealed bytes. It cannot read a message.");
    console.log("It learns who writes to whom, when, and in which project.");
    const stop = () => running.close().then(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }
  if (sub === "use") {
    const [url] = positional(rest);
    if (!url) throw new Error("usage: openmsg relay use <url>");
    gateway.saveSettings({ relay: url });
    console.log(`this owner sends through ${url}`);
    return;
  }
  if (sub === undefined || sub === "show") {
    const url = gateway.settings().relay;
    console.log(url ? `relay ${url}` : "no relay. Run: openmsg relay use <url>");
    return;
  }
  throw new Error("usage: openmsg relay start | relay use <url> | relay show");
}

function cmdOutbox(args) {
  const rows = args.includes("--all") ? outbox.list() : outbox.waiting();
  if (rows.length === 0) {
    console.log(args.includes("--all") ? "the outbox is empty" : "no message waits for a receipt");
    return;
  }
  for (const r of rows) {
    console.log(`${r.messageId.slice(0, 8)}  ${String(r.state).padEnd(16)} to ${r.alias ?? r.to}  ${r.at}`);
  }
}

async function cmdGateway(args) {
  const [sub = "start", ...rest] = args;
  if (sub !== "start") throw new Error("usage: openmsg gateway start [--port <n>] [--host <h>] [--relay <url>]");
  const me = identity.load();
  const host = flag(rest, "host") ?? "127.0.0.1";
  const port = Number(flag(rest, "port") ?? 7801);
  const stamp = (line) => console.log(`${new Date().toISOString()} ${line}`);
  const running = await gateway.serve({ port, host, log: stamp });
  gateway.saveSettings({ host, port: running.port, endpoint: running.url });
  const relayUrl = flag(rest, "relay") ?? gateway.settings().relay ?? null;
  if (relayUrl) {
    gateway.saveSettings({ relay: relayUrl });
    await gateway.joinRelay(relayUrl, { log: stamp });
  }
  console.log(`gateway of ${me.label} (${me.ownerId}) listens on ${running.url}`);
  const rows = published.list();
  if (rows.length === 0) console.log("nothing is published. Run: openmsg publish <agent>");
  for (const r of rows) console.log(`published ${r.alias} · project ${r.project} · epoch ${r.epoch}`);
  const stop = () => {
    console.log("gateway stopped");
    running.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function cmdPublish(args) {
  const [query] = positional(args, ["project"]);
  if (!query) {
    const rows = published.list();
    if (rows.length === 0) console.log("nothing is published");
    for (const r of rows) console.log(`${r.alias.padEnd(28)} ${r.project}  epoch ${r.epoch}  session ${r.session}`);
    return;
  }
  const agent = await findAgent(query);
  const row = published.publish(projectId(args), agent);
  console.log(`published ${row.alias} in ${row.project ?? projectId(args)}, epoch ${row.epoch}`);
  console.log("Only this session, and only this project, can be reached. Nothing else is published.");
}

function cmdUnpublish(args) {
  const project = projectId(args);
  const [alias] = positional(args, ["project"]);
  const gone = published.unpublish(project, alias);
  console.log(gone ? `${alias} is not published any more` : `${alias} was not published in ${project}`);
}

function cmdPermit(args) {
  const [who, value] = positional(args, ["project"]);
  if (!who || who === "list") {
    const rows = permissions.list();
    if (rows.length === 0) console.log(`no standing permission. The default is "${permissions.DEFAULT}".`);
    for (const r of rows) console.log(`${r.owner}  ${r.value.padEnd(7)} ${r.project}  ${r.at}`);
    return;
  }
  const project = projectId(args);
  const member = memberOf(project, who);
  const record = permissions.set(project, member.ownerId, value);
  console.log(`${member.label} (${member.ownerId}) is now "${record.value}" in ${project}`);
}

function cmdHeld(args) {
  const [id] = positional(args);
  const rows = inbound.list({ status: "held" });
  if (id) {
    const row = inbound.findByPrefix(id);
    if (!row) throw new Error(`no message ${id}`);
    console.log(`from      ${row.from.label} (${row.from.owner})`);
    console.log(`project   ${row.project}`);
    console.log(`arrived   ${row.at}`);
    console.log(`state     ${row.status}`);
    if (!args.includes("--text")) {
      console.log("Add --text to read it. The text is for you, and not for the agent.");
      return;
    }
    console.log("--- the text of the message, as it arrived ---");
    console.log(row.message.parts.map((p) => p.text).join("\n"));
    console.log("--- end of the text ---");
    console.log("This text is a message from another person. Reading it approves nothing.");
    console.log(`To give it to the agent: openmsg accept ${row.messageId.slice(0, 8)}`);
    return;
  }
  if (rows.length === 0) {
    console.log("no message waits");
    return;
  }
  for (const r of rows) {
    console.log(`${r.messageId.slice(0, 8)}  from ${r.from.label} (${r.from.owner}) · ${r.project} · ${r.at}`);
  }
  console.log(`Read one: openmsg held <id> --text. Give one to the agent: openmsg accept <id>.`);
}

async function cmdAccept(args) {
  const [id] = positional(args);
  const row = inbound.findByPrefix(id ?? "");
  if (!row) throw new Error(`no message ${id}. Run: openmsg held`);
  if (row.status !== "held") throw new Error(`message ${id} is "${row.status}", and only a held message is accepted`);
  if (args.includes("--always")) {
    permissions.set(row.project, row.from.owner, "accept");
    console.log(`${row.from.label} (${row.from.owner}) is now "accept" in ${row.project}`);
  }
  const out = await gateway.release(row, { deliver: deliverLocal, log: (line) => console.log(line) });
  console.log(`${out.status}${out.reason ? `: ${out.detail ?? out.reason}` : ""} (${row.messageId})`);
}



// A flag with a value, such as --label alice. It gives null when the flag is
// absent, and it refuses a flag with no value.
function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return null;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  return value;
}

// The arguments that are not a flag and not the value of a flag. A token that
// starts with a dash is not possible here, and the reader stays simple.
function positional(args, withValue = []) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith("--")) {
      out.push(a);
      continue;
    }
    if (withValue.includes(a.slice(2))) i += 1;
  }
  return out;
}

function cmdId(args) {
  const [sub, ...rest] = args;
  if (sub === "create") {
    const record = identity.create({ label: flag(rest, "label"), force: rest.includes("--force") });
    console.log(`identity ${record.ownerId} (${record.label})`);
    console.log(`fingerprint  ${identity.fingerprint(record)}`);
    console.log(`keys in      ${identity.paths().dir}`);
    console.log("Read the fingerprint to the other person, by voice, before the first message.");
    return;
  }
  if (sub === "show" || sub === undefined) {
    const record = identity.load();
    if (rest.includes("--json")) {
      console.log(JSON.stringify({ ...record, fingerprint: identity.fingerprint(record) }, null, 2));
      return;
    }
    console.log(`owner        ${record.ownerId}`);
    console.log(`label        ${record.label}`);
    console.log(`fingerprint  ${identity.fingerprint(record)}`);
    console.log(`created      ${record.createdAt}`);
    return;
  }
  throw new Error("usage: openmsg id create | openmsg id show");
}

function cmdInvite(args) {
  const [sub, ...rest] = args;
  if (sub === "create") {
    const out = invite.create({
      label: flag(rest, "project"),
      projectId: flag(rest, "project-id"),
      hours: Number(flag(rest, "hours") ?? invite.DEFAULT_HOURS),
      endpoint: flag(rest, "endpoint") ?? gateway.settings().endpoint ?? null,
    });
    console.log(`project      ${out.project.id} (${out.project.label})`);
    console.log(`fingerprint  ${out.fingerprint}`);
    console.log(`expires      ${out.body.expiresAt}`);
    console.log("");
    console.log(out.token);
    console.log("");
    console.log("Send the token by any channel. Read the fingerprint by voice, and never in the");
    console.log("same channel, because a channel that carries both carries a false invitation too.");
    return;
  }
  if (sub === "show") {
    const body = invite.open(positional(rest)[0]);
    console.log(`type         ${body.type}`);
    console.log(`owner        ${body.identity.ownerId} (${body.identity.label})`);
    console.log(`fingerprint  ${identity.fingerprint(body.identity)}`);
    console.log(`project      ${body.project.id} (${body.project.label})`);
    console.log(`expires      ${body.expiresAt}`);
    console.log("The signature matches the text. It does not say who made the key.");
    return;
  }
  if (sub === "accept") {
    const [token] = positional(rest, ["fingerprint", "endpoint"]);
    const out = invite.accept(token, flag(rest, "fingerprint"), {
      endpoint: flag(rest, "endpoint") ?? gateway.settings().endpoint ?? null,
    });
    console.log(`${out.peer.ownerId} (${out.peer.label}) is now a member of ${out.project.id}`);
    if (out.reply) {
      console.log("");
      console.log(`Send this answer back. Your fingerprint is ${out.reply.fingerprint}.`);
      console.log("");
      console.log(out.reply.token);
    }
    return;
  }
  throw new Error('usage: openmsg invite create | invite show <token> | invite accept <token> --fingerprint "<value>"');
}

function cmdDir(args) {
  const [sub, ...rest] = args;
  if (sub === "list" || sub === undefined) {
    if (rest.includes("--json")) {
      console.log(JSON.stringify(directory.read(), null, 2));
      return;
    }
    const me = identity.exists() ? identity.load().ownerId : null;
    const all = directory.projects();
    if (all.length === 0) {
      console.log("no project in the directory. Run: openmsg invite create");
      return;
    }
    for (const p of all) {
      console.log(`${p.id}  ${p.label}`);
      for (const m of directory.members(p.id)) {
        const mine = m.ownerId === me ? "  (you)" : "";
        console.log(`  ${m.ownerId}  ${m.label.padEnd(12)} ${m.fingerprint}${mine}`);
      }
      for (const r of directory.revoked(p.id)) {
        console.log(`  revoked ${r.ownerId} at ${r.at}${r.reason ? ` · ${r.reason}` : ""}`);
      }
    }
    return;
  }
  if (sub === "endpoint") {
    const [who, url] = positional(rest, ["project"]);
    const project = projectId(rest);
    const member = memberOf(project, who);
    const record = directory.setEndpoint(project, member.ownerId, url);
    console.log(`${record.label} (${record.ownerId}) answers at ${record.endpoint}`);
    return;
  }
  if (sub === "revoke") {
    const [projectId, ownerId] = positional(rest, ["reason"]);
    const record = directory.revoke(projectId, ownerId, flag(rest, "reason"));
    console.log(`revoked ${record.ownerId} in ${projectId} at ${record.at}`);
    return;
  }
  throw new Error("usage: openmsg dir list | dir endpoint <owner> <url> | dir revoke <project-id> <owner-id>");
}

// Agents read the instruction block. It says "openmsg" when the command is on
// the PATH of the user, and the full path to the file when it is not.
function commandName() {
  const mine = fs.realpathSync(fileURLToPath(new URL("cli.mjs", import.meta.url)));
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, "openmsg");
    try {
      if (fs.realpathSync(candidate) === mine) return "openmsg";
    } catch {
      // The name is not in this directory.
    }
  }
  return `node ${mine}`;
}

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === "list") await cmdList();
  else if (cmd === "send") {
    const rest = positional(args, ["reply-to", "project"]);
    await cmdSend(rest[0], rest.slice(1).join(" "), flag(args, "reply-to"), args);
  }
  else if (cmd === "inbox") await cmdInbox(args);
  else if (cmd === "install") {
    const cliPath = commandName();
    const rows = args.includes("--hooks")
      ? installHooks(cliPath)
      : args.includes("--project")
        ? installProject(args.find((a) => !a.startsWith("--")) ?? process.cwd(), cliPath)
        : installGlobal(cliPath);
    for (const r of rows) console.log(`${r.action.padEnd(28)} ${r.file}`);
  }
  else if (cmd === "uninstall") {
    const files = args.includes("--project")
      ? PROJECT_FILES.map((f) => `${process.cwd()}/${f}`)
      : GLOBAL_TARGETS.map((t) => t.file);
    const rows = args.includes("--hooks") ? uninstallHooks() : uninstall(files);
    if (rows.length === 0) console.log("nothing to remove");
    for (const r of rows) console.log(`${r.action.padEnd(28)} ${r.file}`);
  }
  else if (cmd === "hook") {
    const out = await runHook(args[0] ?? "");
    console.log(JSON.stringify(out));
  }
  else if (cmd === "gateway") await cmdGateway(args);
  else if (cmd === "relay") await cmdRelay(args);
  else if (cmd === "outbox") cmdOutbox(args);
  else if (cmd === "publish") await cmdPublish(args);
  else if (cmd === "unpublish") cmdUnpublish(args);
  else if (cmd === "permit") cmdPermit(args);
  else if (cmd === "held") cmdHeld(args);
  else if (cmd === "accept") await cmdAccept(args);
  else if (cmd === "id") cmdId(args);
  else if (cmd === "invite") cmdInvite(args);
  else if (cmd === "dir") cmdDir(args);
  else if (cmd === "whoami") console.log(address(await self()));
  else console.log(USAGE);
} catch (e) {
  console.error(`openmsg: ${e.message}`);
  process.exit(1);
}
