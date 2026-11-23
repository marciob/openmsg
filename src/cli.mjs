#!/usr/bin/env node
// openmsg: send a message from one AI coding agent to another.
import { allAgents, findAgent, self, claudeAgents } from "./registry.mjs";
import { createMessage, address, textOf, MAX_HOPS, layoutOfAnswer, layoutOfSpawnPrompt, compose } from "./envelope.mjs";
import * as asks from "./asks.mjs";
import * as mailbox from "./mailbox.mjs";
import * as projectbox from "./projectbox.mjs";
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
import * as limits from "./limits.mjs";
import * as device from "./device.mjs";
import * as dirsync from "./dirsync.mjs";
import * as notes from "./notes.mjs";
import * as webhooks from "./webhooks.mjs";
import * as mcpagents from "./mcpagents.mjs";
import * as mcp from "./mcp.mjs";
import { createOAuth } from "./oauth.mjs";
import * as spawn from "./spawn.mjs";
import * as voiceowners from "./voiceowners.mjs";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const USAGE = `openmsg — messages between AI coding agents

  openmsg list [--all] [--json]     show the agents that run now, and their work
  openmsg note "<text>"             tell the other agents what this session does
     [--clear]                      remove the note
  openmsg send <agent> <text>       send a message to an agent
     [--reply-to <message-id>]      keep the conversation of that message
  openmsg send project:<dir> <text> the next session in that directory takes it
  openmsg send project:<name>@<owner> <text>   the same, in a directory of another person
     [--key <k>]                    replace the waiting message with that key
  openmsg clear project:<dir> --key <k>   remove the waiting message with that key
  openmsg waiting                   the project messages that wait for a session
  openmsg inbox [--json] [--all]    show the messages for this agent
     [--wait <seconds>]             wait in this turn for a message, with no notice
  openmsg whoami                    show how this agent is addressed
  openmsg webhook add <name> <url>  name an agent that wakes on an HTTP request
     [--header "Name: value"]       a header that the webhook asks for, such as a key
  openmsg webhook remove <name>     take that agent away
  openmsg webhook list              the agents that wake on an HTTP request
  openmsg mcp add <name>            name an agent that reads through MCP, such as a chat product
     [--allow <address>]            an address that it can write to. "*" stands for any text
     [--per-minute <n>]             how many messages it sends in one minute
  openmsg mcp remove <name>         take that agent away
  openmsg mcp trust <name>          a request from that chat counts as a request of yours
  openmsg mcp untrust <name>        stop that
  openmsg ask "<question>"          ask the owner, when the owner is not at this machine
     [--image <file.png|jpg>]       a screenshot to show, up to 4. The question becomes a review
     [--option "<text>"]            an option to choose, 2 to 6. The question becomes a review
  openmsg asks [--json]             the questions that wait for the owner
  openmsg asks --history            the answers of the last 30 days
  openmsg answer <id> yes|no        the answer of the owner. The session that asked gets it as a message
  openmsg answer <id> [--choice <option or number>] [--comment "<text>"]   the answer to a review
  openmsg mcp list                  the agents that read through MCP
  openmsg mcp serve --as <name>     the MCP server of that agent, on the standard input and output
     [--http --port <n>]            the same server over HTTP on the loopback address, behind a token
     [--token-file <file>]          the file of that token. openmsg makes it when it is not there
     [--path </route>]              the path of the server. A random path is harder to find. The default is /mcp
     [--oauth --public-url <url>]   OAuth too, for a product that takes no fixed token, such as Gemini
  openmsg spawn <dir>               open a Claude Code session there, in tmux, and give its address
     [--account <name>]             the account: "default" is ~/.claude, "work" is ~/.claude-work
     [--prompt "<text>"]            the first message of the session
     [--trust-folder]               say yes to the folder question of Claude Code. Ask your user first
     [--no-window]                  open no window of Terminal.app
  openmsg spawn --list              the sessions that openmsg opened, and the accounts
  openmsg close <agent>             stop a session. Its transcript stays, for claude --resume
  openmsg close --idle [<hours>]    stop each session that openmsg opened and that had no turn (12 hours)
  openmsg operator start            open the session that a chat of yours talks to, in ~/.openmsg/operator
     [--account <name>]
  openmsg hook <vendor>             run inside a hook of claude, cursor, or gemini
  openmsg install                   let every agent on this machine answer messages
  openmsg install --hooks           add the hooks for claude, cursor, and gemini
  openmsg install --project [dir]   the same, for one project only
  openmsg uninstall [--project]     remove what install wrote

For the agents of another person, on another machine:

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
  openmsg publish --all             let the project reach every session, and each new one
  openmsg unpublish <alias>         take a session back
  openmsg unpublish --all           go back to the sessions that you named
  openmsg permit <owner> <accept|hold|refuse>
  openmsg trust <owner>             that identity is yours, such as a bot: its request counts as yours
  openmsg untrust <owner>           stop that
  openmsg held [<id>] [--text]      the messages that wait for you
  openmsg held --all                every message from another person, and its state
  openmsg accept <id> [--always]    give a held message to the agent
  openmsg ack <id>                  say that you read a message
  openmsg limits                    the limits that this machine holds
  openmsg device create [--label <n>]  give this machine its own keys
  openmsg device request            ask the machine that holds the owner key
  openmsg device grant <token>      answer a request, on the owner machine
     [--days <n>] [--project <id>]
  openmsg device accept <token>     keep the answer, on the new machine
  openmsg device show               the machine, and what it may sign
  openmsg dir revoke-device <project-id> <device-id>
  openmsg dir sync                  send and read the directory of each project
  openmsg dir pending               the owners that wait for you to accept them
  openmsg dir accept <owner> --fingerprint "<value>"
  openmsg device revoke <id>        tell the team that a machine of yours is gone
  openmsg relay start [--port <n>] [--cert <file>] [--key <file>]
  openmsg relay use <url> [--ca <file>]   send through that relay
  openmsg relay wake <name> | --off      the relay wakes webhook:<name> when its machine stops
  openmsg relay allow [<owner-id>]       on the relay: take only the owners on this list [--remove]
  openmsg outbox [--all]            the messages that wait for a receipt

A message to another person goes to "claude:api-worker@alice".

Addresses look like "claude:api-worker" or "opencode:ses_123".
`;

// "5m", "3h", "2d": the time since a moment, in the largest whole unit.
function ago(ms) {
  if (!ms) return null;
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// Two records name one session when the vendor and the session id agree.
function sameSession(a, b) {
  return Boolean(a && b && a.vendor === b.vendor && a.id === b.id);
}

async function cmdList(args = []) {
  // Several sessions can run in one directory with names that look alike. The
  // mark "(you)" shows the agent which row is its own, so that it does not send
  // to itself. A command outside a session has no row, and it gets no mark.
  const [all, me] = await Promise.all([
    allAgents().then((a) => notes.attach(a)),
    self().catch(() => null),
  ]);
  const agents = args.includes("--all") ? all : all.filter((a) => !a.background);
  const hidden = all.length - agents.length;
  // The agents of other people, from the last routing data on this machine.
  // An agent with a shell finds them here, and needs no MCP connector.
  const others = directory.remoteAgents();
  if (args.includes("--json")) {
    const local = agents.map(({ transport, ...a }) => ({ ...a, you: sameSession(a, me) }));
    const far = others.map((r) => ({ ...r, remote: true, you: false }));
    console.log(JSON.stringify([...local, ...far], null, 1));
    return;
  }
  if (agents.length === 0) {
    console.log(hidden ? `no running agents found. ${hidden} background sessions: openmsg list --all` : "no running agents found");
    printRemote(others);
    return;
  }
  const width = Math.max(...agents.map((a) => address(a).length));
  const tilde = (p) => (p && p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p);
  for (const a of agents) {
    const times = [a.startedAt && `started ${ago(a.startedAt)} ago`, a.updatedAt && `active ${ago(a.updatedAt)} ago`];
    const you = sameSession(a, me) ? "(you)" : "";
    const head = [address(a).padEnd(width), a.status.padEnd(7), times.filter(Boolean).join(", "), you];
    console.log(head.join("  ").trimEnd());
    // The note of the agent comes first, because the agent wrote it about the
    // work of now. The title of the vendor comes next.
    const about = a.note ? `note: ${a.note}` : a.title ?? "(no title)";
    console.log(`  ${[about, tilde(a.cwd)].filter(Boolean).join(" · ")}`);
  }
  if (hidden) console.log(`\n${hidden} background sessions not shown. See them: openmsg list --all`);
  printRemote(others);
}

// The routing data can be old: the other gateway answered at that time.
function printRemote(others) {
  if (others.length === 0) return;
  console.log("\nagents of other people, from the last answer of their gateway:");
  const width = Math.max(...others.map((r) => r.address.length));
  for (const r of others) console.log(`${r.address.padEnd(width)}  ${r.status.padEnd(9)}  as of ${ago(Date.parse(r.at))} ago`);
  if (others.some((r) => r.status === "stale")) {
    console.log("stale: the answer is older than 10 minutes, and that gateway can be offline now. A send tells.");
  }
}

async function cmdNote(args) {
  const me = await self();
  if (me.vendor === "shell" || me.unresolved) {
    throw new Error("only an agent session has a note. Run this command from inside the agent.");
  }
  const text = args.includes("--clear") ? "" : args.filter((a) => a !== "--clear").join(" ");
  if (!text && !args.includes("--clear")) {
    console.log(notes.get(me) ?? "no note. Write one: openmsg note \"<what you work on>\"");
    return;
  }
  const note = notes.set(me, text);
  console.log(note ? `${address(me)}: ${note}` : `${address(me)}: note removed`);
}

async function cmdSend(target, text, replyTo = null, args = []) {
  if (!target || !text) throw new Error('usage: openmsg send <agent> "<text>" [--reply-to <message-id>]');
  // An alias with an owner, such as "claude:api-worker@alice", belongs to
  // another person. That message goes through the two gateways.
  // "project:web-app@alice" names a directory of another person by its name.
  // A project address of this machine holds a path, and a path has a slash,
  // a dot, or a tilde.
  if (/^project:[^/.~@][^/@]*@[^/@]+$/.test(target)) return cmdSendRemote(target, text, replyTo, args);
  if (projectbox.isProjectAddress(target)) return cmdSendProject(target, text, replyTo, args);
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
  if (sameSession(to, from)) {
    throw new Error(
      `${address(to)} is this session. An agent does not send a message to itself. ` +
        "Leave it out of the recipients.",
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
        "Ask your user if they want to continue. If the user says yes, send the text again " +
        "as a new message, without --reply-to. A new message starts a new conversation.",
    );
  }

  const result = await deliverLocal(to, message);
  if (mcpagents.speaksForOwner(from)) {
    mcpagents.recordVoice({ from: address(from), to: address(to), messageId: message.messageId, text });
  }

  // "delivered" means an adapter pushed the message into the live session.
  // "queued" means it waits in the mailbox for an agent that reads it at the
  // end of a turn.
  // The adapter of a webhook agent writes the mailbox before it sends its
  // notice, so the agent that wakes finds the message.
  if (!result.stored) mailbox.put(to, message, result.delivered ? "delivered" : "queued");
  const how = result.delivered
    ? `sent to ${address(to)} over ${result.transport}`
    : result.detail
      ? `queued for ${address(to)} in the mailbox, because ${result.detail}. That agent reads it at its next check`
      : `queued for ${address(to)} in the mailbox. That agent reads it at the end of its next turn`;
  console.log(`${how} (${message.messageId})`);
}

// The sender of a project message. A program names itself with OPENMSG_SELF,
// and openmsg does not look that name up: a lookup asks every vendor for its
// sessions, and a scheduled check must stay small and fast.
async function senderOfProjectMessage() {
  const value = process.env.OPENMSG_SELF;
  if (!value) return self();
  const [vendor, ...rest] = value.includes(":") ? value.split(":") : ["shell", value];
  const name = rest.join(":");
  return { vendor, id: name, name, unresolved: true };
}

async function cmdSendProject(target, text, replyTo, args) {
  if (replyTo) throw new Error("a project message is not a reply. Send it without --reply-to");
  const dir = projectbox.dirOfAddress(target);
  const from = await senderOfProjectMessage();
  const to = { vendor: "project", id: dir, name: dir };
  const message = createMessage({ from, to, text });
  message.openmsg.hops = [address(from)];
  const key = flag(args, "key");
  if (key) message.openmsg.key = key;
  projectbox.put(dir, message);

  // Only the records of Claude Code, because they are files. The discovery of
  // Codex and OpenCode runs lsof, and that costs seconds.
  // A session that sends to its own directory does not get its own message.
  const live = claudeAgents()
    .filter((a) => projectbox.sessionIsIn(a.cwd, dir) && !sameSession(a, from))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const agent of live) {
    const got = projectbox.takeMessage(dir, message);
    if (!got) break;
    try {
      const result = await deliverLocal(agent, got.message);
      mailbox.put(agent, got.message, "delivered");
      console.log(`sent to ${address(agent)} over ${result.transport} (${message.messageId})`);
      return;
    } catch (e) {
      projectbox.restore(dir, got);
      console.error(`openmsg: ${address(agent)}: ${e.message}`);
    }
  }
  console.log(`waits in ${dir}. The next session there takes it (${message.messageId})`);
}

function cmdClear(args) {
  const [target] = positional(args, ["key"]);
  const key = flag(args, "key");
  if (!projectbox.isProjectAddress(target) || !key) throw new Error("usage: openmsg clear project:<dir> --key <key>");
  const dir = projectbox.dirOfAddress(target);
  console.log(projectbox.clear(dir, key) ? `removed "${key}" from ${dir}` : `no message "${key}" waits in ${dir}`);
}

function cmdWaiting() {
  const rows = projectbox.all();
  if (rows.length === 0) return console.log("no project message waits");
  for (const { dir, messages } of rows) {
    for (const m of messages) {
      const key = m.openmsg.key ? ` [${m.openmsg.key}]` : "";
      if (m.openmsg.version === remote.VERSION) {
        // A message from another person. Its text is for the session that
        // takes it, and the owner reads it with `held`.
        const who = `${m.openmsg.from.vendor}:${m.openmsg.from.name ?? m.openmsg.from.id}@${m.sender?.label ?? m.openmsg.from.owner}`;
        const was = m.placed?.wasFor;
        console.log(`${dir} from ${who} at ${m.createdAt} (${m.messageId.slice(0, 8)})`);
        console.log(was ? `  It was for the session ${was.alias}, which ended.` : "  It is for the directory, and not for one session.");
        if (was?.vendor === "claude") console.log(`  Open that conversation again: cd ${dir} && claude --resume ${was.session}`);
        console.log(`  The next session in that directory takes it. Read it: openmsg held ${m.messageId.slice(0, 8)} --text\n`);
        continue;
      }
      console.log(`${dir}${key} from ${address(m.openmsg.from)} at ${m.createdAt}\n${textOf(m)}\n`);
    }
  }
}

async function cmdInbox(args) {
  const me = await self();
  // A wait for a message in this turn, up to that number of seconds. A
  // message that arrives in the wait goes to the mailbox with no notice.
  const waitFor = flag(args, "wait");
  if (waitFor !== undefined && waitFor !== null) {
    const seconds = Number(waitFor);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) throw new Error("--wait takes a number of seconds, from 1 to 600");
    await waitForMail(me, seconds * 1000);
  }
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
        // A message for a webhook agent holds the text that a model reads: the
        // header, the text of the sender, and the notice after it. A session
        // of another vendor got those words from its adapter.
        if (r.rendered) console.log(`${r.rendered}\n`);
        else console.log(`from ${address(r.openmsg.from)} at ${r.createdAt}\n${r.parts.map((p) => p.text).join("\n")}\n`);
      }
    }
  }
  mailbox.markRead(me, rows.map((r) => r.messageId));
  await acknowledgeRead(rows);
}

async function waitForMail(me, ms) {
  const end = Date.now() + ms;
  if (mailbox.list(me, { unreadOnly: true }).length > 0) return;
  mailbox.markWaiting(me, end);
  const stop = () => mailbox.clearWaiting(me);
  process.once("SIGINT", () => {
    stop();
    process.exit(130);
  });
  try {
    while (Date.now() < end) {
      await new Promise((r) => setTimeout(r, 1000));
      if (mailbox.list(me, { unreadOnly: true }).length > 0) return;
    }
  } finally {
    stop();
  }
}

// A read of the mailbox is an event from the agent, and rule 1 of section 8
// of the spec of 0.2 gives it the state "agent-acknowledged". Only a message
// from another person has a row in that store.
async function acknowledgeRead(rows) {
  for (const r of rows) {
    if (r.openmsg?.version !== remote.VERSION) continue;
    const row = inbound.find(r.messageId);
    if (!row || !["queued", "adapter-accepted"].includes(row.status)) continue;
    inbound.setStatus(row.messageId, "agent-acknowledged");
    // The sender learns the state when a way to it exists. A read never fails
    // because the sender is offline.
    await gateway.reportState(row, "agent-acknowledged").catch(() => {});
  }
}

async function cmdMcp(args) {
  // --allow can come more than one time.
  const allow = [];
  const words = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--allow") {
      if (args[i + 1] === undefined) throw new Error('--allow needs an address, such as "claude:*"');
      allow.push(args[++i]);
    } else if (["--per-minute", "--as", "--port", "--token-file", "--path", "--public-url"].includes(args[i])) {
      i += 1;
    } else if (args[i] !== "--http" && args[i] !== "--oauth") words.push(args[i]);
  }
  const [sub, name] = words;
  if (sub === "serve") {
    const as = flag(args, "as");
    if (!as) throw new Error("usage: openmsg mcp serve --as <name> [--http --port <n> --token-file <file>]");
    if (!mcpagents.get(as)) throw new Error(`no agent mcp:${as}. Run: openmsg mcp add ${as}`);
    if (!args.includes("--http")) {
      await mcp.serve({ name: as });
      return;
    }
    // The token is in a file that only the owner reads. No command prints it.
    const file = flag(args, "token-file") ?? path.join(identity.home(), `mcp-${as}.token`);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, mcp.newToken(), { mode: 0o600 });
    }
    const token = fs.readFileSync(file, "utf8").trim();
    const stamp = (line) => console.log(`${new Date().toISOString()} ${line}`);
    const route = flag(args, "path") ?? "/mcp";
    // OAuth, for a product that takes no fixed token. The owner approves each
    // connection with the secret of the token file.
    let oauth = null;
    if (args.includes("--oauth")) {
      const publicUrl = flag(args, "public-url");
      if (!publicUrl) throw new Error("--oauth needs --public-url <the https address of the route, as the network sees it>");
      oauth = createOAuth({ name: as, ownerSecret: token, publicUrl, route, file: path.join(identity.home(), `mcp-${as}.oauth.json`), log: stamp });
    }
    const running = await mcp.serveHttp({ name: as, token, port: Number(flag(args, "port") ?? 7812), route, log: stamp, oauth });
    if (oauth) stamp(`OAuth: the address for the product is ${flag(args, "public-url")}. The approval page asks for the secret in ${file}`);
    stamp(`mcp:${as} listens on ${running.url}, and each request needs the token in ${file}`);
    stamp('The header of a request: "Authorization: Bearer <token>". A proxy in front gives the address to the network, with TLS.');
    const stop = () => running.close().then(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }
  if (sub === "add") {
    if (!name) throw new Error("usage: openmsg mcp add <name> [--allow <address>] [--per-minute <n>]");
    const per = flag(args, "per-minute");
    const row = mcpagents.add(name, { allow, perMinute: per === null ? null : Number(per) });
    console.log(`mcp:${row.name} reads its mailbox through MCP, and nothing wakes it`);
    console.log(
      row.allow.length > 0
        ? `It can write to: ${row.allow.join(", ")}`
        : `It can write to nobody yet. Give an address: openmsg mcp add ${row.name} --allow "<address>"`,
    );
    console.log(`It sends ${row.perMinute} messages in one minute at most.`);
    console.log(`The command of its connector: openmsg mcp serve --as ${row.name}`);
    return;
  }
  if (sub === "trust" || sub === "untrust") {
    if (!name) throw new Error(`usage: openmsg mcp ${sub} <name>`);
    mcpagents.setVoice(name, sub === "trust");
    if (sub === "untrust") {
      console.log(`A message from mcp:${name} is a message from another agent again. It approves no action.`);
      return;
    }
    console.log(`A request from mcp:${name} now counts as a request of yours, for each agent on this machine.`);
    console.log("It does not approve an action that deletes data, that cannot be undone, or that changes a permission.");
    console.log("The model behind that chat reads text of other people, and such text can try to make it send.");
    console.log("Keep the question that the chat product asks before each send. That question is the one bound.");
    console.log(`Each such message is in ${path.join(identity.home(), "voice.jsonl")}. To stop: openmsg mcp untrust ${name}`);
    return;
  }
  if (sub === "remove") {
    if (!name) throw new Error("usage: openmsg mcp remove <name>");
    console.log(mcpagents.remove(name) ? `mcp:${name} is gone` : `no agent mcp:${name}`);
    return;
  }
  if (sub === undefined || sub === "list") {
    const rows = mcpagents.agents();
    if (rows.length === 0) console.log("no agent reads through MCP. Run: openmsg mcp add <name>");
    for (const a of rows) {
      const row = mcpagents.get(a.name);
      const voice = row.voice ? "  ·  speaks for the owner" : "";
      console.log(`${address(a)}  writes to: ${row.allow.join(", ") || "nobody"}  ·  ${row.perMinute} in one minute${voice}`);
    }
    return;
  }
  throw new Error("usage: openmsg mcp add <name> | mcp remove <name> | mcp trust <name> | mcp untrust <name> | mcp list | mcp serve --as <name>");
}

// A session that openmsg opens for a chat of the owner. The owner is away,
// and no session runs in that project yet.
async function cmdSpawn(args) {
  if (args.includes("--list")) {
    const rows = spawn.running();
    if (rows.length === 0) console.log("openmsg opened no session that runs now");
    for (const r of rows) console.log(`${(r.address ?? "(no address yet)").padEnd(28)} ${r.tmux}  ${r.account}  ${r.dir}  since ${r.startedAt}`);
    console.log(`accounts: ${spawn.accounts().map((a) => `${a.name} (${a.dir})`).join(", ")}`);
    console.log(`at most ${process.env.OPENMSG_SPAWN_MAX ?? spawn.DEFAULT_MAX} at one time. To look at one: tmux attach -t <tmux name>`);
    return;
  }
  const [dir] = positional(args, ["account", "prompt"]);
  if (!dir) throw new Error('usage: openmsg spawn <dir> [--account <name>] [--prompt "<text>"] [--trust-folder] [--no-window]');
  // A session that waits too long for a turn closes first, so it takes no place.
  for (const { row, agent } of spawn.idle()) {
    const done = await spawn.close({ agent, tmuxName: row.tmux });
    if (done.stopped) console.log(`closed ${row.address ?? row.tmux}: no turn for ${spawn.DEFAULT_IDLE_HOURS} hours`);
  }
  // A session that runs this command writes the first message for the owner.
  // The new session must see that, and not a message that its user typed.
  let prompt = flag(args, "prompt");
  if (prompt && AGENT_ENV.some((name) => process.env[name])) {
    const from = await self();
    if (from && !from.unresolved) prompt = compose(layoutOfSpawnPrompt(address(from), prompt));
  }
  const out = await spawn.open({
    dir,
    account: flag(args, "account"),
    prompt,
    trustFolder: args.includes("--trust-folder"),
    view: !args.includes("--no-window"),
  });
  if (!out.agent) {
    const why = out.alive
      ? "it runs, but discovery does not find it yet. Look again with: openmsg list"
      : "it stopped before it started. Look at: tmux ls";
    console.log(`opened ${out.tmux} in ${out.dir}, and ${why}`);
    return;
  }
  console.log(`opened claude:${out.agent.name} in ${out.dir}, with the account ${out.account}`);
  console.log(`To write to it: openmsg send "claude:${out.agent.name}" "<text>"`);
  console.log(`To close it: openmsg close "claude:${out.agent.name}"`);
  console.log(`It runs in tmux as ${out.tmux}${out.viewed ? ", and a window of Terminal.app shows it" : ""}. To look at it: tmux attach -t ${out.tmux}`);
}

async function cmdClose(args) {
  if (args.includes("--idle")) {
    const [hours] = positional(args.filter((a) => a !== "--idle"));
    const rows = spawn.idle({ hours: hours === undefined ? spawn.DEFAULT_IDLE_HOURS : Number(hours) });
    if (rows.length === 0) console.log("no session that openmsg opened is idle that long");
    for (const { row, agent } of rows) {
      const done = await spawn.close({ agent, tmuxName: row.tmux });
      console.log(`${done.stopped ? "closed" : "could not close"} ${row.address ?? row.tmux}`);
    }
    return;
  }
  const [target] = positional(args);
  if (!target) throw new Error("usage: openmsg close <agent> | close --idle [<hours>]");
  let agent = null;
  let tmuxName = null;
  if (/^om-/.test(target)) tmuxName = target;
  else {
    agent = await findAgent(target);
    if (sameSession(agent, await self())) {
      throw new Error(`${address(agent)} is this session. A session does not close itself with openmsg`);
    }
    // A program, a chat, or a webhook agent has no process on this machine.
    if (!agent.pid || !["claude", "codex", "opencode", "cursor", "gemini"].includes(agent.vendor)) {
      throw new Error(`${address(agent)} has no process on this machine, so there is nothing to close`);
    }
    if (agent.vendor !== "claude") {
      throw new Error(`openmsg closes a Claude Code session only. ${address(agent)} is ${agent.vendor}`);
    }
  }
  const done = await spawn.close({ agent, tmuxName });
  if (!done.stopped) throw new Error(`${target} did not stop. Its process can still run: look at it with ps`);
  console.log(`closed ${agent ? address(agent) : target}${done.opened ? ", and its tmux session" : ""}`);
  const again = spawn.resumeCommand(done);
  if (again) console.log(`The transcript stays. To open it again: ${again}`);
}

const OPERATOR_DIR = () => path.join(identity.home(), "operator");

// The session that a chat of the owner talks to. It opens sessions, closes
// them, and writes to them. Its instructions are in the CLAUDE.md of its
// directory, and the owner can change that file.
async function cmdOperator(args) {
  const [sub] = positional(args, ["account"]);
  if (sub !== "start") throw new Error("usage: openmsg operator start [--account <name>]");
  const dir = OPERATOR_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const instructions = path.join(dir, "CLAUDE.md");
  if (!fs.existsSync(instructions)) {
    const template = fileURLToPath(new URL("../operator/CLAUDE.md", import.meta.url));
    fs.copyFileSync(template, instructions);
    console.log(`wrote ${instructions}`);
  }
  const real = fs.realpathSync(dir);
  const live = claudeAgents().find((a) => a.cwd && fs.existsSync(a.cwd) && fs.realpathSync(a.cwd) === real && !a.background);
  if (live) {
    console.log(`the operator runs already: claude:${live.name}`);
  } else {
    const out = await spawn.open({
      dir,
      account: flag(args, "account"),
      // The owner runs this command, and the folder holds only the file above.
      trustFolder: true,
      role: "operator",
      view: !args.includes("--no-window"),
    });
    if (!out.agent) throw new Error(`the operator did not start. Look at: tmux attach -t ${out.tmux}`);
    console.log(`the operator runs: claude:${out.agent.name}, in tmux as ${out.tmux}`);
  }
  const label = identity.exists() ? identity.load().label : "<your label>";
  console.log(`A chat or a bot of yours writes to it with: openmsg send "project:${path.basename(dir)}@${label}" "<text>"`);
  console.log(`On this machine: openmsg send "project:${dir}" "<text>"`);
}

// An identity on another machine that belongs to the owner, such as a bot.
// Only the owner runs this command.
function cmdTrust(args, on) {
  const [who] = positional(args, ["project"]);
  if (!who) throw new Error(`usage: openmsg ${on ? "trust" : "untrust"} <owner>`);
  if (AGENT_ENV.some((name) => process.env[name])) {
    throw new Error("only the owner changes this mark. This command runs inside a session of an agent");
  }
  const member = memberOf(projectId(args), who);
  if (identity.exists() && member.ownerId === identity.load().ownerId) throw new Error("that is your own identity on this machine");
  voiceowners.set(member.ownerId, member.label, on);
  if (!on) {
    console.log(`A message from ${member.label} is a message from another person again. It approves no action.`);
    return;
  }
  console.log(`A request from ${member.label} (${member.ownerId}) now counts as a request of yours, for each session on this machine.`);
  console.log("It does not approve an action that deletes data, that cannot be undone, or that changes a permission.");
  console.log(`Give this mark only to an identity that is yours, such as your own bot. Whoever controls ${member.label} then works on this machine in your name.`);
  console.log(`Each such message is in ${path.join(identity.home(), "voice.jsonl")}. To stop: openmsg untrust ${member.label}`);
}

// An agent asks its owner, and the owner is not at the machine.
// Each value of a flag that can come more than one time.
function flags(args, name) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== `--${name}`) continue;
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
    out.push(value);
    i += 1;
  }
  return out;
}

async function cmdAsk(args) {
  const question = positional(args, ["image", "option"]).join(" ");
  if (!question) throw new Error('usage: openmsg ask "<one question, with the exact action>" [--image <file>] [--option "<text>"]');
  const from = await self();
  if (!from || from.unresolved || ["shell", "mcp", "webhook"].includes(from.vendor)) {
    throw new Error("only a session on this machine asks its owner. openmsg did not find the session of this command");
  }
  const row = asks.put({ from, question, images: flags(args, "image"), options: flags(args, "option") });
  console.log(`The ${row.kind === "review" ? "review" : "question"} ${row.id} waits for your user.`);
  console.log(row.kind === "review"
    ? "The answer arrives in this session as a message from your user: an option, a comment, or both. Wait for it before you build on one option."
    : "The answer arrives in this session as a message from your user. Do not do the action before it arrives.");
  console.log("If a chat of your user asked for this work, tell that chat that a question waits for the owner.");
}

function cmdAsks(args) {
  if (args.includes("--history")) {
    const done = asks.history();
    if (done.length === 0) console.log("no question has an answer yet");
    for (const r of done) {
      const said = r.answer === "feedback" ? [r.choice && `chose: ${r.choice}`, r.comment && `comment: ${r.comment}`].filter(Boolean).join("\n    ") : null;
      console.log(`${r.answeredAt}  ${r.answer.padEnd(3)}  ${address(r.from)}  through ${r.via}\n    ${r.question}${said ? `\n    ${said}` : ""}`);
    }
    return;
  }
  const rows = asks.waiting();
  if (args.includes("--json")) {
    console.log(JSON.stringify(rows.map((r) => ({
      id: r.id, kind: r.kind ?? "approval", from: address(r.from), dir: r.from.cwd, question: r.question, askedAt: r.askedAt,
      ...(r.kind === "review" ? { options: r.options, images: r.images.map((name) => path.join(asks.filesDir(), name)) } : {}),
    })), null, 1));
    return;
  }
  if (rows.length === 0) console.log("no question waits for the owner");
  for (const r of rows) {
    if (r.kind === "review") {
      const lines = [...r.options.map((o, i) => `${i + 1}. ${o}`), ...r.images.map((name) => `image: ${path.join(asks.filesDir(), name)}`)];
      console.log(`${r.id}  review  ${address(r.from)}  ${r.askedAt}\n    ${r.question}${lines.map((l) => `\n    ${l}`).join("")}\n    openmsg answer ${r.id} --choice <n> --comment "<text>"`);
    } else console.log(`${r.id}  ${address(r.from)}  ${r.askedAt}\n    ${r.question}\n    openmsg answer ${r.id} yes   |   openmsg answer ${r.id} no`);
  }
}

// The environment of a command that an agent runs. The owner answers, and an
// agent does not answer its own question. A program with the account of the
// owner can take these names away, so this is a guard against a mistake, and
// not a wall.
const AGENT_ENV = ["CLAUDECODE", "CLAUDE_CODE_MESSAGING_SOCKET", "CODEX_THREAD_ID", "OPENCODE_SESSION_ID", "OPENMSG_SELF"];

async function cmdAnswer(args) {
  const [id, word] = positional(args, ["via", "choice", "comment"]);
  const isReview = args.includes("--choice") || args.includes("--comment");
  if (!id || (isReview ? word !== undefined : !["yes", "no"].includes(word))) {
    throw new Error('usage: openmsg answer <id> yes|no, or openmsg answer <id> [--choice <option or number>] [--comment "<text>"]');
  }
  if (AGENT_ENV.some((name) => process.env[name])) {
    throw new Error("only the owner answers a question. This command runs inside a session of an agent");
  }
  const via = { via: flag(args, "via") ?? "the command line" };
  const row = isReview
    ? asks.review(id, { choice: flag(args, "choice"), comment: flag(args, "comment") }, via)
    : asks.answer(id, word === "yes", via);
  const live = (await allAgents()).find((a) => a.vendor === row.from.vendor && a.id === row.from.id);
  const to = live ?? row.from;
  const parts = layoutOfAnswer(row);
  const message = createMessage({
    from: { vendor: "owner", id: "owner", name: "owner" },
    to,
    text: parts.body,
  });
  if (!live) {
    // The session ended. The answer waits in its mailbox, as a record.
    mailbox.put(to, { ...message, rendered: compose(parts) }, "queued");
    console.log(`${said(row)} is the answer to ${row.id}. The session ${address(to)} ended, and the answer is in its mailbox.`);
    return;
  }
  const result = await deliverLocal(live, message, { parts });
  if (!result.stored) mailbox.put(live, { ...message, rendered: compose(parts) }, result.delivered ? "delivered" : "queued");
  console.log(`${said(row)} is the answer to ${row.id}, and ${address(live)} ${result.delivered ? "has it" : "reads it at the end of its next turn"}.`);
}

function said(row) {
  return row.answer === "feedback" ? (row.choice ? `"${row.choice}"` : "a comment") : row.answer;
}

function cmdWebhook(args) {
  // --header can come more than one time, and each one takes the next word.
  const headers = [];
  const words = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--header") {
      if (args[i + 1] === undefined) throw new Error('--header needs a value, such as "Authorization: Bearer <key>"');
      headers.push(args[++i]);
    } else words.push(args[i]);
  }
  const [sub, name, url] = words;
  if (sub === "add") {
    if (!name || !url) throw new Error('usage: openmsg webhook add <name> <url> [--header "Name: value"]');
    const row = webhooks.add(name, url, { headers });
    console.log(`webhook:${row.name} wakes on a request to the address that you gave`);
    const names = Object.keys(row.headers);
    if (names.length > 0) console.log(`Each request carries the header ${names.join(", ")}. Its value is a secret too.`);
    console.log("That address is a secret. A person who holds it can wake the agent, and cannot write to it.");
    console.log(`The agent names itself with: export OPENMSG_SELF=webhook:${row.name}`);
    return;
  }
  if (sub === "remove") {
    if (!name) throw new Error("usage: openmsg webhook remove <name>");
    console.log(webhooks.remove(name) ? `webhook:${name} is gone` : `no agent webhook:${name}`);
    return;
  }
  if (sub === undefined || sub === "list") {
    const rows = webhooks.agents();
    if (rows.length === 0) console.log("no agent wakes on an HTTP request. Run: openmsg webhook add <name> <url>");
    // The host shows which service takes the notice. The path holds the secret.
    for (const a of rows) console.log(`${address(a)}  ${new URL(a.transport.url).host}`);
    return;
  }
  throw new Error("usage: openmsg webhook add <name> <url> | webhook remove <name> | webhook list");
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
  // A relay that does not answer is not the end of a message. The machine of
  // the relay can sleep, and the message then waits in the outbox of this
  // machine, with the routing data that this machine read before.
  let link = null;
  let unreachable = null;
  if (!direct) {
    try {
      link = await relaylink.open(relayUrl, { onReceipt: (frame) => receipts.push(frame) });
    } catch (e) {
      unreachable = e.message;
    }
  }

  let rows;
  let label = member.label;
  let fromCache = false;
  try {
    if (unreachable) throw new Error(unreachable);
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
    fromCache = true;
  }

  const row = rows.find((r) => r.alias === alias || r.name === alias || r.session === alias);
  if (!row) {
    link?.close();
    const names = rows.map((r) => `${r.alias}@${label}`).join(", ") || "nothing";
    throw new Error(`${member.label} does not publish "${alias}" in this project. Published: ${names}`);
  }
  if (row.live === false && row.vendor !== "project") {
    console.error(`openmsg: the session ${row.alias}@${label} does not run now. The next session in its directory takes the message.`);
  }
  // An earlier message to this agent that nobody read. A second message does
  // not help a busy agent, and it costs one more run of an agent that pays.
  for (const quiet of outbox.silent({ alias: `${alias}@${label}` })) {
    console.error(`openmsg: ${outbox.silenceNote(quiet)}`);
  }
  // The message is sealed for the machine that holds that session, and the
  // routing data of that machine gave this key.
  const sealTo = row.sealTo ?? null;

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
    // The sender knows here that the message will wait.
    ttlMs: fromCache || row.live === false ? remote.WAIT_TTL_MS : remote.DEFAULT_TTL_MS,
  });
  const wire = remote.pack(message, { recipient: member, sealTo });
  const how = {
    "adapter-accepted": `reached the agent of ${member.label}`,
    held: `waits for ${member.label} to accept you`,
    queued: `waits on the machine of ${member.label}, for an agent that reads its mailbox or for the next session in that directory`,
    "relay-holds": `the relay holds it for ${member.label}, who is offline now`,
    "outbox-holds":
      `waits on this machine for ${member.label}, because the relay does not answer. ` +
      "Your gateway sends it when the relay answers. See it: openmsg outbox",
  };
  const row0 = { messageId: message.messageId, to: member.ownerId, project, alias: `${alias}@${label}`, wire };
  let out;
  if (direct) {
    out = await gateway.send(member, wire);
  } else if (!link) {
    outbox.put({ ...row0, state: "queued", pending: true });
    out = { status: "outbox-holds" };
  } else {
    // The sender keeps its copy until a receipt arrives. The relay keeps its
    // own copy at the same time.
    outbox.put({ ...row0, state: "sending" });
    const answer = await link.send(wire);
    if (answer.type !== "stored" && gateway.RELAY_GONE.includes(answer.reason)) {
      // The connection stopped before the relay said that it holds the message.
      outbox.setState(message.messageId, "queued", { pending: true });
      link.close();
      link = null;
      out = { status: "outbox-holds" };
    } else if (answer.type !== "stored") {
      outbox.setState(message.messageId, "refused", { reason: answer.reason });
      link.close();
      console.log(`refused by the relay: ${answer.reason} (${message.messageId})`);
      process.exitCode = 1;
      return;
    }
  }
  if (link) {
    outbox.setState(message.messageId, "queued");
    // A message that waited here from an earlier try goes on the same connection.
    await gateway.flushOutbox(link).catch(() => {});
    // A receipt says what happened at the other end. It can arrive in a
    // moment, or days later, and then the gateway of this owner takes it.
    const receipt = await waitForReceipt(receipts, message.messageId, 3000);
    link.close();
    if (receipt) {
      outbox.advance(message.messageId, receipt.status, { reason: receipt.reason ?? null });
      out = { status: receipt.status, reason: receipt.reason };
    } else {
      out = { status: "relay-holds" };
    }
  }
  console.log(`${how[out.status] ?? `${out.status}${out.reason ? `: ${out.reason}` : ""}`} (${message.messageId})`);
  if (out.status === "refused") process.exitCode = 1;

  // An answer is the proof that the agent read the message. No hook and no
  // transport gives that proof.
  if (answered && out.status !== "refused") {
    inbound.setStatus(answered.messageId, "replied");
    const told = await gateway.reportState(answered, "replied").catch((e) => ({ sent: false, why: e.message }));
    if (!told.sent) console.error(`openmsg: ${answered.from.label} does not know yet: ${told.why}`);
  }
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

// The keys of one machine, and the record that the owner signs for them.
async function cmdDevice(args) {
  const [sub, ...rest] = args;
  if (sub === "create") {
    const record = device.create({ label: flag(rest, "label"), force: rest.includes("--force") });
    console.log(`machine ${record.deviceId} (${record.label})`);
    console.log(`keys in  ${device.paths().dir}`);
    if (identity.exists() && identity.hasPrivateKeys()) {
      // This machine holds the owner key, so it answers its own request.
      const { record: given } = device.grant(device.readRequest(device.request()), {
        days: Number(flag(rest, "days") ?? device.DEFAULT_DAYS),
        projects: flag(rest, "project") ? [flag(rest, "project")] : "all",
      });
      device.saveDelegation(given);
      console.log(`the owner key signed it until ${given.expiresAt}`);
      console.log("From now on this machine signs with its own key.");
    } else {
      console.log("This machine holds no owner key. Run: openmsg device request");
    }
    return;
  }
  if (sub === "request") {
    console.log(device.request());
    console.log("");
    console.log("Give this text to the machine that holds your owner key, and run there:");
    console.log("  openmsg device grant <token>");
    return;
  }
  if (sub === "grant") {
    const [token] = positional(rest, ["days", "project"]);
    const ask = device.readRequest(token);
    const { record, token: answer } = device.grant(ask, {
      days: Number(flag(rest, "days") ?? device.DEFAULT_DAYS),
      projects: flag(rest, "project") ? [flag(rest, "project")] : "all",
    });
    console.log(`machine  ${record.device} (${record.label})`);
    console.log(`projects ${record.projects === "all" ? "all" : record.projects.join(", ")}`);
    console.log(`until    ${record.expiresAt}`);
    console.log("");
    console.log(answer);
    console.log("");
    console.log("Give this text back to that machine, and run there: openmsg device accept <token>");
    return;
  }
  if (sub === "accept") {
    const [token] = positional(rest);
    const record = device.saveDelegation(device.readGrant(token));
    console.log(`this machine signs for ${record.owner} until ${record.expiresAt}`);
    return;
  }
  if (sub === "show" || sub === undefined) {
    const record = device.load();
    console.log(`machine   ${record.deviceId} (${record.label})`);
    console.log(`created   ${record.createdAt}`);
    const held = record.delegation;
    if (!held) {
      console.log("It has no delegation, so the owner key signs each message. Run: openmsg device request");
      return;
    }
    console.log(`owner     ${held.owner}`);
    console.log(`projects  ${held.projects === "all" ? "all" : held.projects.join(", ")}`);
    console.log(`until     ${held.expiresAt}`);
    return;
  }
  if (sub === "revoke") {
    const [which] = positional(rest, ["reason"]);
    if (!which) throw new Error("usage: openmsg device revoke <device-id> [--reason <text>]");
    const me = identity.load();
    const reason = flag(rest, "reason");
    const records = [];
    for (const entry of directory.projects()) {
      if (!directory.member(entry.id, me.ownerId)) continue;
      directory.revokeDevice(entry.id, which, reason, { owner: me.ownerId });
      records.push(dirsync.revokeDeviceRecord(entry.id, which, reason));
      console.log(`revoked ${which} in ${entry.id}`);
    }
    const url = gateway.settings().relay;
    if (!url || records.length === 0) {
      console.log("Run: openmsg dir sync, on a machine with a relay, so the team learns it.");
      return;
    }
    return relaylink.open(url).then(async (link) => {
      for (const record of records) await link.publishRecord(record);
      link.close();
      console.log(`the team learns it through ${url}`);
    });
  }
  throw new Error("usage: openmsg device create | request | grant <token> | accept <token> | revoke <id> | show");
}

async function cmdRelay(args) {
  const [sub, ...rest] = args;
  if (sub === "start") {
    const host = flag(rest, "host") ?? "127.0.0.1";
    const port = Number(flag(rest, "port") ?? 7800);
    const running = await relay.serve({
      port,
      host,
      cert: flag(rest, "cert"),
      key: flag(rest, "key"),
      insecure: rest.includes("--insecure"),
      log: (line) => console.log(`${new Date().toISOString()} ${line}`),
    });
    console.log(`relay listens on ${running.url}, store in ${relay.home()}`);
    console.log("It carries sealed bytes. It cannot read a message.");
    console.log("It learns who writes to whom, when, and in which project.");
    const owners = relay.allowedOwners();
    if (owners === null) {
      console.log("WARNING: no list of owners. Any owner that finds this address can connect and store messages.");
      console.log("Name the owners of the team with: openmsg relay allow <owner-id>");
    } else {
      console.log(`It takes ${owners.length} owners: ${owners.join(", ") || "none"}`);
    }
    const stop = () => running.close().then(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }
  if (sub === "allow") {
    // On the machine of the relay. The list holds from the next hello.
    const off = rest.includes("--remove");
    const [owner] = rest.filter((a) => !a.startsWith("--"));
    if (!owner) {
      const list = relay.allowedOwners();
      console.log(list === null ? "no list: the relay takes any owner" : list.join("\n") || "an empty list: the relay takes no owner");
      return;
    }
    const list = relay.allowOwner(owner, { remove: off });
    console.log(`${off ? "removed" : "added"} ${owner}. The relay takes ${list.length} owners. A connection that is open now stays open until it ends.`);
    return;
  }
  if (sub === "use") {
    const [url] = positional(rest, ["ca"]);
    if (!url) throw new Error("usage: openmsg relay use <url> [--ca <file>] [--insecure]");
    const ca = flag(rest, "ca");
    const insecure = rest.includes("--insecure");
    gateway.saveSettings({ relay: url, relayCa: ca ?? null, relayInsecure: insecure });
    console.log(`this owner sends through ${url}`);
    if (ca) console.log(`and it trusts the certificate in ${ca}`);
    if (new URL(url).protocol === "ws:" && !relay.isLoopback(new URL(url).hostname)) {
      console.log(
        insecure
          ? "WARNING: no TLS. The messages stay sealed, and the addresses travel in the open."
          : "That address has no TLS. Add --insecure if you accept that, or use a wss:// address.",
      );
    }
    return;
  }
  if (sub === "wake") {
    const url = gateway.settings().relay;
    if (!url) throw new Error("no relay. Run: openmsg relay use <url>");
    const off = rest.includes("--off");
    const [name] = rest.filter((a) => !a.startsWith("--"));
    let wake = null;
    if (!off) {
      if (!name) throw new Error("usage: openmsg relay wake <name> | relay wake --off");
      const agent = webhooks.agents().find((a) => a.name === name);
      if (!agent) throw new Error(`no agent webhook:${name}. Run: openmsg webhook add ${name} <url>`);
      wake = { url: agent.transport.url, headers: agent.transport.headers ?? {}, agent: `webhook:${name}` };
    }
    const link = await relaylink.open(url);
    try {
      const answer = off ? await link.clearWake() : await link.setWake(wake);
      if (answer.type === "wake-refused") throw new Error(`the relay refused the wake address: ${answer.reason}`);
      if (answer.type === "refused") throw new Error(`the relay did not answer: ${answer.reason}`);
      console.log(
        off
          ? "the relay wakes no agent of this owner"
          : `the relay wakes webhook:${name} when a message waits 15 seconds with no machine to take it. ` +
              "The relay now holds the address of that webhook.",
      );
    } finally {
      link.close();
    }
    return;
  }
  if (sub === undefined || sub === "show") {
    const url = gateway.settings().relay;
    console.log(url ? `relay ${url}` : "no relay. Run: openmsg relay use <url>");
    return;
  }
  throw new Error("usage: openmsg relay start [--cert <f> --key <f>] | relay use <url> [--ca <f>] | relay wake <name> | relay show");
}

function cmdOutbox(args) {
  const rows = args.includes("--all") ? outbox.list() : outbox.waiting();
  const quiet = outbox.silent();
  if (rows.length === 0 && quiet.length === 0) {
    console.log(args.includes("--all") ? "the outbox is empty" : "no message waits for a receipt");
    return;
  }
  for (const r of rows) {
    const where = r.pending ? "  (on this machine, the relay did not answer)" : "";
    console.log(`${r.messageId.slice(0, 8)}  ${String(r.state).padEnd(16)} to ${r.alias ?? r.to}  ${r.at}${where}`);
  }
  if (quiet.length > 0) {
    if (rows.length > 0) console.log("");
    console.log("no answer:");
    for (const r of quiet) console.log(`  ${outbox.silenceNote(r)}`);
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
  for (const id of published.openProjects()) stamp(`every session of this machine is published in ${id}`);
  if (rows.length === 0 && published.openProjects().length === 0) console.log("nothing is published. Run: openmsg publish <agent>");
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
  if (args.includes("--all")) {
    const project = projectId(args);
    published.setOpen(project, true);
    console.log(`every session of this machine can be reached in ${project}, and each new session too`);
    console.log("A member of that project can write to each of them. Your permission for each sender still holds.");
    console.log("Stop it: openmsg unpublish --all. A gateway that runs takes the change at once.");
    return;
  }
  if (!query) {
    const rows = published.list();
    for (const id of published.openProjects()) console.log(`${"every session".padEnd(28)} ${id}  each session that runs, and each new one`);
    if (rows.length === 0 && published.openProjects().length === 0) console.log("nothing is published");
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
  if (args.includes("--all")) {
    const was = published.setOpen(project, false);
    console.log(was ? `only the sessions that you named are published in ${project} now` : `${project} did not take every session`);
    return;
  }
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
  if (args.includes("--all") && !id) {
    const all = inbound.list().sort((a, b) => (a.at < b.at ? -1 : 1));
    if (all.length === 0) console.log("no message from another person");
    for (const r of all) {
      const why = r.reason ? ` · ${r.reason}` : "";
      console.log(`${r.messageId.slice(0, 8)}  ${String(r.status).padEnd(18)} from ${r.from?.label ?? "unknown"}${why}  ${r.at}`);
    }
    // A state that holds a doubt says so here. No protocol removes that doubt.
    for (const state of [...new Set(all.map((r) => r.status))]) {
      if (inbound.EXPLAIN[state]) console.log(`${state}: ${inbound.EXPLAIN[state]}`);
    }
    return;
  }
  const rows = inbound.list({ status: "held" });
  if (id) {
    const row = inbound.findByPrefix(id);
    if (!row) throw new Error(`no message ${id}`);
    console.log(`from      ${row.from.label} (${row.from.owner})`);
    console.log(`project   ${row.project}`);
    console.log(`arrived   ${row.at}`);
    console.log(`state     ${row.status} — ${inbound.EXPLAIN[row.status] ?? "unknown"}`);
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

// The agent says that it read the message. Only this event gives the state
// "agent-acknowledged". A write to a socket never proves that a model read.
async function cmdAck(args) {
  const [id] = positional(args);
  const row = inbound.findByPrefix(id ?? "");
  if (!row) throw new Error(`no message ${id}. Run: openmsg held --all`);
  if (!["adapter-accepted", "agent-acknowledged", "replied"].includes(row.status)) {
    throw new Error(`message ${id} is "${row.status}", and an acknowledgement belongs to a message that reached the agent`);
  }
  if (row.status === "adapter-accepted") inbound.setStatus(row.messageId, "agent-acknowledged");
  const told = await gateway.reportState(row, "agent-acknowledged").catch((e) => ({ sent: false, why: e.message }));
  console.log(
    `acknowledged ${row.messageId}` +
      (told.sent ? `, and ${row.from.label} knows over ${told.how}` : `. ${row.from.label} does not know yet: ${told.why}`),
  );
}

function cmdLimits() {
  const values = limits.values();
  const rows = inbound.list();
  console.log(`${values.senderPerWindow} messages from one sender in ${Math.round(values.senderWindowMs / 60_000)} minutes`);
  console.log(`${values.turnsPerSession} turns from remote messages in one session in ${Math.round(values.turnWindowMs / 60_000)} minutes`);
  console.log(`${values.heldMax} messages that wait for the owner (${rows.filter((r) => r.status === "held").length} now)`);
  console.log(`Change a value in ${identity.home()}/limits.json`);
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
      endpoint: flag(rest, "endpoint") ?? gateway.advertised(),
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
      endpoint: flag(rest, "endpoint") ?? gateway.advertised(),
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

async function cmdDir(args) {
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
      for (const r of directory.revokedDevices(p.id)) {
        console.log(`  revoked machine ${r.device} at ${r.at}${r.reason ? ` · ${r.reason}` : ""}`);
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
  if (sub === "sync") {
    const url = gateway.settings().relay;
    if (!url) throw new Error("no relay. Run: openmsg relay use <url>");
    return relaylink.open(url).then(async (link) => {
      const named = flag(rest, "project");
      const rows = await gateway.syncDirectory(link, {
        log: (line) => console.log(line),
        projects: named ? [named] : [],
      });
      link.close();
      const total = rows.reduce((n, r) => n + r.added.length + r.updated.length + r.revoked.length, 0);
      console.log(`${rows.length} projects, ${total} changes, ${directory.pending().length} owners wait for you`);
    });
  }
  if (sub === "pending") {
    const rows = directory.pending(flag(rest, "project") ?? null);
    if (rows.length === 0) {
      console.log("nobody waits");
      return;
    }
    for (const r of rows) {
      console.log(`${r.ownerId}  ${String(r.label).padEnd(12)} ${r.fingerprint}  ${r.project}`);
    }
    console.log("Compare a fingerprint with that person, and then:");
    console.log('  openmsg dir accept <owner> --fingerprint "<value>"');
    return;
  }
  if (sub === "accept") {
    const [who] = positional(rest, ["fingerprint", "project"]);
    const project = projectId(rest);
    const record = dirsync.acceptPending(project, who, flag(rest, "fingerprint"));
    console.log(`${record.label} (${record.ownerId}) is now a member of ${project}`);
    return;
  }
  if (sub === "revoke-device") {
    const [projectId, deviceId] = positional(rest, ["reason"]);
    const record = directory.revokeDevice(projectId, deviceId, flag(rest, "reason"));
    console.log(`revoked the machine ${record.device} in ${projectId} at ${record.at}`);
    console.log("The identity of that person holds. Only that machine stops.");
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
  if (cmd === "list") await cmdList(args);
  else if (cmd === "note") await cmdNote(args);
  else if (cmd === "send") {
    const rest = positional(args, ["reply-to", "project", "key"]);
    await cmdSend(rest[0], rest.slice(1).join(" "), flag(args, "reply-to"), args);
  }
  else if (cmd === "inbox") await cmdInbox(args);
  else if (cmd === "clear") cmdClear(args);
  else if (cmd === "waiting") cmdWaiting();
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
  else if (cmd === "device") await cmdDevice(args);
  else if (cmd === "relay") await cmdRelay(args);
  else if (cmd === "outbox") cmdOutbox(args);
  else if (cmd === "publish") await cmdPublish(args);
  else if (cmd === "unpublish") cmdUnpublish(args);
  else if (cmd === "permit") cmdPermit(args);
  else if (cmd === "held") cmdHeld(args);
  else if (cmd === "accept") await cmdAccept(args);
  else if (cmd === "ack") await cmdAck(args);
  else if (cmd === "limits") cmdLimits();
  else if (cmd === "id") cmdId(args);
  else if (cmd === "invite") cmdInvite(args);
  else if (cmd === "dir") await cmdDir(args);
  else if (cmd === "webhook") cmdWebhook(args);
  else if (cmd === "mcp") await cmdMcp(args);
  else if (cmd === "ask") await cmdAsk(args);
  else if (cmd === "asks") cmdAsks(args);
  else if (cmd === "answer") await cmdAnswer(args);
  else if (cmd === "spawn") await cmdSpawn(args);
  else if (cmd === "close") await cmdClose(args);
  else if (cmd === "operator") await cmdOperator(args);
  else if (cmd === "trust") cmdTrust(args, true);
  else if (cmd === "untrust") cmdTrust(args, false);
  else if (cmd === "whoami") console.log(address(await self()));
  else console.log(USAGE);
} catch (e) {
  console.error(`openmsg: ${e.message}`);
  process.exit(1);
}
