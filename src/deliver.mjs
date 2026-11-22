// One place that hands a message to the adapter of a vendor. The command line
// of 0.1 and the gateway of 0.2 both come here, so the last step is the same
// for a message from this machine and for a message from another person.
import * as claude from "./adapters/claude.mjs";
import * as opencode from "./adapters/opencode.mjs";
import * as codex from "./adapters/codex.mjs";
import * as webhook from "./adapters/webhook.mjs";
import * as mailbox from "./mailbox.mjs";
import { layoutOf, compose, bodyRange } from "./envelope.mjs";

// `parts` is the layout of the text that the model reads: the frame and the text
// of the sender. Each adapter shows the two apart in its own way:
//   Claude Code shows the color of an escape sequence, so the frame is gray
//   and the text of the sender is blue.
//   Codex removes each escape sequence, but it draws a byte range in its accent
//   color. The text of the sender gets that color, and the model never sees it.
//   OpenCode shows no color. The person sees the header and the text of the
//   sender, and the notice after them goes in a part that only the model reads.
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
  if (agent.vendor === "opencode") return opencode.deliver(agent, message, parts ? { layout: parts } : { text });
  if (agent.vendor === "codex") return codex.deliver(agent, message, { text: plain, highlight: parts ? bodyRange(parts) : null });
  if (agent.vendor === "webhook") return wake(agent, message, plain);
  // An agent with no push entry point reads its mailbox: Gemini CLI and Cursor
  // CLI at the end of a turn, and an MCP agent when its user asks. The
  // message waits there, with the text that the model reads. A message from
  // another person has no other way into that mailbox.
  keep(agent, message, plain);
  return { delivered: false, transport: "mailbox", stored: true };
}

// A message that arrives a second time, before the agent read the first copy,
// does not go to the mailbox twice.
function keep(agent, message, rendered) {
  const waits = mailbox.list(agent, { unreadOnly: true }).some((m) => m.messageId === message.messageId);
  if (!waits) mailbox.put(agent, { ...message, rendered }, "queued");
}

// An agent that wakes on an HTTP request. The message goes to the mailbox
// first, with the text that the model reads, and the request goes after it.
// The agent that wakes therefore always finds the message. `stored` tells the
// caller that the mailbox holds the message already.
async function wake(agent, message, rendered) {
  // The agent gets a new notice for a message that arrives a second time.
  keep(agent, message, rendered);
  // The agent waits for a message in this turn, so it reads this one now.
  // A notice would start a second turn, and the agent can pay for each one.
  if (mailbox.isWaiting(agent)) return { delivered: true, transport: "mailbox-read-waits", stored: true };
  try {
    return { ...(await webhook.deliver(agent, message)), stored: true };
  } catch (e) {
    // A notice that failed loses no message. The message waits in the mailbox,
    // and the agent reads it at its next check.
    return { delivered: false, transport: "mailbox", stored: true, detail: e.message };
  }
}
