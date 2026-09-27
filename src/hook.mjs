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
import path from "node:path";
import { register } from "./selfregistry.mjs";
import { claudeAgents } from "./registry.mjs";
import * as mailbox from "./mailbox.mjs";
import * as projectbox from "./projectbox.mjs";
import { render, MAX_HOPS } from "./envelope.mjs";

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
function readEvent(vendor, input) {
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

export async function runHook(vendor) {
  const raw = await readStdin();
  let input = {};
  try {
    input = raw ? JSON.parse(raw) : {};
  } catch {
    // A hook must never stop the agent. An unreadable input gives no message.
  }
  const info = readEvent(vendor, input);
  const within = (m) => (m.openmsg?.hops?.length ?? 0) <= MAX_HOPS;

  if (vendor === "claude") {
    const taken = projectbox.take(info.cwd).map((t) => t.message).filter(within);
    if (taken.length === 0) return {};
    // The mailbox of a Claude session goes by its name. The session record
    // holds the name, and a reply looks there.
    const agent = claudeAgents().find((a) => a.id === info.id) ?? { vendor, id: info.id, cwd: info.cwd };
    for (const m of taken) mailbox.put(agent, m, "delivered");
    return {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: taken.map((m) => render(m)).join("\n\n"),
      },
    };
  }

  const agent = agentOf(vendor, info);
  register(agent);

  const waiting = mailbox.list(agent, { unreadOnly: true }).filter(within);
  const taken = projectbox.take(info.cwd).map((t) => t.message).filter(within);
  if (waiting.length === 0 && taken.length === 0) return {};

  // A project message goes into the mailbox of this session, so a reply finds
  // it there.
  for (const m of taken) mailbox.put(agent, m, "read");
  const text = [...waiting, ...taken].map((m) => render(m)).join("\n\n");
  mailbox.markRead(agent, waiting.map((m) => m.messageId));

  if (vendor === "cursor") {
    // A stop hook submits the text as the next message of the user.
    if (info.event === "sessionStart") return { additional_context: text };
    return { followup_message: text };
  }
  if (vendor === "gemini") {
    // An AfterAgent hook that denies sends its reason as a new prompt.
    if (info.event === "SessionStart") return { additional_context: text };
    return { decision: "deny", reason: text };
  }
  return { additional_context: text };
}
