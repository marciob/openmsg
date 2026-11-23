// `openmsg hook <vendor>` runs inside a hook of an agent. It does three things:
//
// 1. It registers the session, because Cursor CLI and Gemini CLI keep no
//    record that another program can read.
// 2. It gives the waiting messages to the agent, in the shape that the vendor
//    expects at the end of a turn.
// 3. It gives the project messages of the working directory to the agent.
//    Claude Code runs the hook only for this, at the start of a session. A
//    live Claude session takes every other message through its socket.
//
// Sources:
// - Claude Code: https://code.claude.com/docs/en/hooks
// - Cursor: https://cursor.com/docs/hooks
// - Gemini: https://geminicli.com/docs/hooks/reference/
// - Antigravity CLI: https://antigravity.google/docs/hooks/
import path from "node:path";
import { register } from "./selfregistry.mjs";
import { claudeAgents, agyAgents, agyName } from "./registry.mjs";
import * as mailbox from "./mailbox.mjs";
import * as projectbox from "./projectbox.mjs";
import { render, MAX_HOPS } from "./envelope.mjs";
import * as inbound from "./inbound.mjs";

// A message from another person that waited in the box of a directory. Its
// deadline can pass while it waits, and then no model reads it. The store of
// the owner takes the new state, and the gateway tells the sender later,
// because a hook must be fast.
function fromAnotherPerson(m) {
  return m.openmsg?.version === 2;
}

function takeRemote(m, sessionId) {
  const late = !(Date.parse(m.openmsg.expiresAt) > Date.now());
  try {
    if (inbound.find(m.messageId)) {
      if (late) inbound.setStatus(m.messageId, "expired", { reason: "expired", unreported: true });
      else inbound.setStatus(m.messageId, "adapter-accepted", { transport: "project-box", deliveredTo: sessionId, unreported: true });
    }
  } catch {
    // A hook must never stop the agent.
  }
  return !late;
}

// The words that a model reads. A message from another person holds them
// already, with the name of its owner and the place.
function textFor(m) {
  return m.rendered ?? render(m);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (data += d));
    process.stdin.on("end", () => resolve(data));
    // A hook that gets no input must not hang.
    setTimeout(() => resolve(data), 2000).unref?.();
  });
}

// Each vendor names the session and the working directory in its own way.
function readEvent(vendor, input, eventArg = null) {
  if (vendor === "cursor") {
    return {
      event: input.hook_event_name ?? "stop",
      id: input.conversation_id ?? input.session_id ?? "unknown",
      cwd: input.workspace_roots?.[0] ?? process.cwd(),
    };
  }
  if (vendor === "gemini") {
    return {
      event: input.hook_event_name ?? input.event ?? "AfterAgent",
      id: input.session_id ?? input.sessionId ?? "unknown",
      cwd: input.cwd ?? input.workspace_root ?? process.cwd(),
    };
  }
  if (vendor === "agy") {
    // The input does not always name the event, so the hook command gives it.
    // A workspace can come as a file:// URI.
    const workspace = input.workspacePaths?.[0] ?? input.cwd ?? process.cwd();
    return {
      event: eventArg ?? input.hookEventName ?? "Stop",
      id: input.conversationId ?? "unknown",
      cwd: String(workspace).startsWith("file://") ? decodeURIComponent(new URL(workspace).pathname) : workspace,
    };
  }
  return {
    event: input.hook_event_name ?? "SessionStart",
    id: input.session_id ?? "unknown",
    cwd: input.cwd ?? process.cwd(),
  };
}

function agentOf(vendor, { id, cwd }) {
  const base = cwd ? path.basename(cwd) : vendor;
  return { vendor, id, name: `${base}-${String(id).slice(-4)}`, cwd };
}

export async function runHook(vendor, eventArg = null) {
  const raw = await readStdin();
  let input = {};
  try {
    input = raw ? JSON.parse(raw) : {};
  } catch {
    // A hook must never stop the agent. An unreadable input gives no message.
  }
  const info = readEvent(vendor, input, eventArg);
  const within = (m) => (m.openmsg?.hops?.length ?? 0) <= MAX_HOPS;

  if (vendor === "claude") {
    const taken = projectbox
      .take(info.cwd)
      .map((t) => t.message)
      .filter(within)
      .filter((m) => !fromAnotherPerson(m) || takeRemote(m, info.id));
    if (taken.length === 0) return {};
    // The mailbox of a Claude session goes by its name. The session record
    // holds the name, and a reply looks there.
    const agent = claudeAgents().find((a) => a.id === info.id) ?? { vendor, id: info.id, cwd: info.cwd };
    for (const m of taken) mailbox.put(agent, m, "delivered");
    return {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: taken.map(textFor).join("\n\n"),
      },
    };
  }

  // An input with no session names nobody, so the hook registers nothing.
  if (info.id === "unknown") return {};
  // The name of an agy session comes from discovery, so the hook reads the
  // mailbox that a sender writes to.
  let agent = agentOf(vendor, info);
  if (vendor === "agy") {
    const live = (await agyAgents()).find((a) => a.id === info.id);
    agent = live ? { vendor, id: info.id, name: live.name, cwd: live.cwd } : { vendor, id: info.id, name: agyName(info.cwd, info.id), cwd: info.cwd };
  }
  register(agent);

  const waiting = mailbox.list(agent, { unreadOnly: true }).filter(within);
  const taken = projectbox
    .take(info.cwd)
    .map((t) => t.message)
    .filter(within)
    .filter((m) => !fromAnotherPerson(m) || takeRemote(m, info.id));
  if (waiting.length === 0 && taken.length === 0) return {};

  // A project message goes into the mailbox of this session, so a reply finds
  // it there.
  for (const m of taken) mailbox.put(agent, m, "read");
  const text = [...waiting, ...taken].map(textFor).join("\n\n");
  mailbox.markRead(agent, waiting.map((m) => m.messageId));

  if (vendor === "cursor") {
    // A stop hook submits the text as the next message of the user.
    if (info.event === "sessionStart") return { additional_context: text };
    return { followup_message: text };
  }
  if (vendor === "agy") {
    // Stop with "continue" keeps the turn going, and the reason goes in as a
    // system message. SessionStart adds a system step. Neither one is a prompt
    // of the user. Section 7.0 of the spec of 0.1.
    if (info.event === "SessionStart") return { injectSteps: [{ systemMessage: { systemMessage: text } }] };
    return { decision: "continue", reason: text };
  }
  if (vendor === "gemini") {
    // An AfterAgent hook that denies sends its reason as a new prompt.
    // SessionStart gives its text as the first turn of the history.
    if (info.event === "SessionStart") {
      return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } };
    }
    return { decision: "deny", reason: text };
  }
  return { additional_context: text };
}
