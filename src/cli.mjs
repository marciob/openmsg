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

const USAGE = `openmsg — messages between AI coding agents

  openmsg list                      show the agents that run now
  openmsg send <agent> <text>       send a message to an agent
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

async function cmdSend(target, text) {
  if (!target || !text) throw new Error('usage: openmsg send <agent> "<text>"');
  const to = await findAgent(target);
  const from = await self();
  const message = createMessage({ from, to, text });
  message.openmsg.hops = [address(from)];
  if (message.openmsg.hops.length > MAX_HOPS) throw new Error("hop limit reached");

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

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === "list") await cmdList();
  else if (cmd === "send") await cmdSend(args[0], args.slice(1).join(" "));
  else if (cmd === "inbox") await cmdInbox(args);
  else if (cmd === "install") {
    const cliPath = `node ${fileURLToPath(new URL("cli.mjs", import.meta.url))}`;
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
