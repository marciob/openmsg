// One place that hands a message to the adapter of a vendor. The command line
// of 0.1 and the gateway of 0.2 both come here, so the last step is the same
// for a message from this machine and for a message from another person.
import * as claude from "./adapters/claude.mjs";
import * as opencode from "./adapters/opencode.mjs";
import * as codex from "./adapters/codex.mjs";

// Claude Code shows the color of an escape sequence in the text of a message.
// Codex removes each escape sequence, and the other vendors are not tested.
export function showsColor(vendor) {
  return vendor === "claude";
}

// `text` is the text that the model reads. The adapters make it from the
// envelope of 0.1 when the caller gives none.
export async function deliverLocal(agent, message, { text = null } = {}) {
  if (agent.vendor === "claude") {
    // The token belongs to the session that runs this command. Another session
    // reads its socket without one.
    const token = agent.transport?.path === process.env.CLAUDE_CODE_MESSAGING_SOCKET
      ? process.env.CLAUDE_CODE_MESSAGING_TOKEN
      : undefined;
    return claude.deliver(agent, message, { token, text });
  }
  if (agent.vendor === "opencode") return opencode.deliver(agent, message, { text });
  if (agent.vendor === "codex") return codex.deliver(agent, message, { text });
  // An agent with no push entry point, such as Gemini CLI or Cursor CLI, reads
  // its mailbox at the end of a turn. The message waits there.
  return { delivered: false, transport: "mailbox" };
}
