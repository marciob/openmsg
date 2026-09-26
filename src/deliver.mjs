// One place that hands a message to the adapter of a vendor. The command line
// of 0.1 and the gateway of 0.2 both come here, so the last step is the same
// for a message from this machine and for a message from another person.
import * as claude from "./adapters/claude.mjs";
import * as opencode from "./adapters/opencode.mjs";
import * as codex from "./adapters/codex.mjs";
import { layoutOf, compose, bodyRange } from "./envelope.mjs";

// `parts` is the layout of the text that the model reads: the frame and the text
// of the sender. Each adapter shows the two apart in its own way:
//   Claude Code shows the color of an escape sequence, so the frame is gray.
//   Codex removes each escape sequence, but it draws a byte range in its accent
//   color. The text of the sender gets that color, and the model never sees it.
//   OpenCode gets the plain text. Its display is not tested.
// `text` alone, with no layout, goes to the adapter as it is.
export async function deliverLocal(agent, message, { text = null, parts = null } = {}) {
  if (!parts && !text) parts = layoutOf(message);
  const plain = parts ? compose(parts) : text;
  if (agent.vendor === "claude") {
    // The token belongs to the session that runs this command. Another session
    // reads its socket without one.
    const token = agent.transport?.path === process.env.CLAUDE_CODE_MESSAGING_SOCKET
      ? process.env.CLAUDE_CODE_MESSAGING_TOKEN
      : undefined;
    return claude.deliver(agent, message, { token, text: parts ? compose(parts, { ansi: true }) : text });
  }
  if (agent.vendor === "opencode") return opencode.deliver(agent, message, { text: plain });
  if (agent.vendor === "codex") return codex.deliver(agent, message, { text: plain, highlight: parts ? bodyRange(parts) : null });
  // An agent with no push entry point, such as Gemini CLI or Cursor CLI, reads
  // its mailbox at the end of a turn. The message waits there.
  return { delivered: false, transport: "mailbox" };
}
