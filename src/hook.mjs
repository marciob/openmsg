// `openmsg hook <vendor>` runs inside a hook of an agent. It does two things:
//
// 1. It registers the session, because Cursor CLI and Gemini CLI keep no
//    record that another program can read.
// 2. It gives the waiting messages to the agent, in the shape that the vendor
//    expects at the end of a turn.
//
// Sources:
// - Cursor: https://cursor.com/docs/hooks
// - Gemini: https://geminicli.com/docs/hooks/reference/
import path from "node:path";
import { register } from "./selfregistry.mjs";
import * as mailbox from "./mailbox.mjs";
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
  return { event: "stop", id: input.session_id ?? "unknown", cwd: process.cwd() };
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
  const agent = agentOf(vendor, info);
  register(agent);

  const waiting = mailbox
    .list(agent, { unreadOnly: true })
    .filter((m) => (m.openmsg?.hops?.length ?? 0) <= MAX_HOPS);

  if (waiting.length === 0) return {};

  const text = waiting.map((m) => render(m)).join("\n\n");
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
