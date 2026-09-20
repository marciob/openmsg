#!/usr/bin/env node
// openmsg: send a message from one AI coding agent to another.
import { allAgents, findAgent, self } from "./registry.mjs";
import { createMessage, address, MAX_HOPS } from "./envelope.mjs";
import * as mailbox from "./mailbox.mjs";
import * as claude from "./adapters/claude.mjs";
import * as opencode from "./adapters/opencode.mjs";
import * as codex from "./adapters/codex.mjs";
import { installGlobal, installProject, uninstall, GLOBAL_TARGETS, PROJECT_FILES } from "./install.mjs";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const USAGE = `openmsg — messages between AI coding agents

  openmsg list                      show the agents that run now
  openmsg send <agent> <text>       send a message to an agent
     [--reply-to <message-id>]      keep the conversation of that message
  openmsg inbox [--json] [--all]    show the messages for this agent
  openmsg whoami                    show how this agent is addressed
  openmsg install                   let every agent on this machine answer messages
  openmsg install --project [dir]   the same, for one project only
  openmsg uninstall [--project]     remove what install wrote

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

async function cmdSend(target, text, replyTo = null) {
  if (!target || !text) throw new Error('usage: openmsg send <agent> "<text>" [--reply-to <message-id>]');
  const to = await findAgent(target);
  const from = await self();
  // A reply keeps the conversation of the message that it answers, and it adds
  // this agent to the chain of hops.
  const answered = replyTo ? mailbox.find(from, replyTo) : null;
  if (replyTo && !answered) throw new Error(`no message ${replyTo} in the mailbox of ${address(from)}`);
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

  let result;
  if (to.vendor === "claude") {
    const token = to.transport.path === process.env.CLAUDE_CODE_MESSAGING_SOCKET
      ? process.env.CLAUDE_CODE_MESSAGING_TOKEN
      : undefined;
    result = await claude.deliver(to, message, { token });
  } else if (to.vendor === "opencode") {
    result = await opencode.deliver(to, message);
  } else if (to.vendor === "codex") {
    result = await codex.deliver(to, message);
  } else {
    throw new Error(`no adapter for vendor "${to.vendor}" yet`);
  }

  mailbox.put(to, message, "sent");
  console.log(`sent to ${address(to)} over ${result.transport} (${message.messageId})`);
}

async function cmdInbox(args) {
  const me = await self();
  const rows = mailbox.list(me, { unreadOnly: !args.includes("--all") });
  if (args.includes("--json")) {
    console.log(JSON.stringify(rows, null, 2));
  } else if (rows.length === 0) {
    console.log("no messages");
  } else {
    for (const r of rows) {
      console.log(`from ${address(r.openmsg.from)} at ${r.createdAt}\n${r.parts.map((p) => p.text).join("\n")}\n`);
    }
    mailbox.markRead(me);
  }
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
    const flag = args.indexOf("--reply-to");
    const replyTo = flag === -1 ? null : args[flag + 1];
    const rest = flag === -1 ? args : [...args.slice(0, flag), ...args.slice(flag + 2)];
    await cmdSend(rest[0], rest.slice(1).join(" "), replyTo);
  }
  else if (cmd === "inbox") await cmdInbox(args);
  else if (cmd === "install") {
    const cliPath = commandName();
    const rows = args.includes("--project")
      ? installProject(args.find((a) => !a.startsWith("--")) ?? process.cwd(), cliPath)
      : installGlobal(cliPath);
    for (const r of rows) console.log(`${r.action.padEnd(28)} ${r.file}`);
  }
  else if (cmd === "uninstall") {
    const files = args.includes("--project")
      ? PROJECT_FILES.map((f) => `${process.cwd()}/${f}`)
      : GLOBAL_TARGETS.map((t) => t.file);
    const rows = uninstall(files);
    if (rows.length === 0) console.log("nothing to remove");
    for (const r of rows) console.log(`${r.action.padEnd(28)} ${r.file}`);
  }
  else if (cmd === "whoami") console.log(address(await self()));
  else console.log(USAGE);
} catch (e) {
  console.error(`openmsg: ${e.message}`);
  process.exit(1);
}
