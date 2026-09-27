// Adapter: OpenCode.
// The OpenCode user interface is a client of a local HTTP server. Any program
// can send a prompt to a session with one request.
// Source: https://opencode.ai/docs/server/
//
// OpenCode draws the text of a user message in one color. It shows no escape
// sequence and no markdown there. It shows only the first text part that is not
// `synthetic`, and the model reads every part, in order. So the header, the text
// of the sender, and the line of dashes after it go in one part that the person
// sees. The notice and the answer command go in a synthetic part: the model
// reads them, and the screen does not show them.
// Source: packages/opencode/src/cli/cmd/tui/routes/session/index.tsx (v1.1.11),
// packages/opencode/src/session/message-v2.ts.
import { render, RULE } from "../envelope.mjs";

export function partsOf({ head, body, foot }) {
  const cut = foot.indexOf(RULE) + 1;
  const shown = { type: "text", text: [...head, body, ...foot.slice(0, cut)].join("\n") };
  const rest = foot.slice(cut);
  return rest.length ? [shown, { type: "text", synthetic: true, text: rest.join("\n") }] : [shown];
}

export async function deliver(agent, message, { text = null, layout = null } = {}) {
  const url = `${agent.transport.base}/session/${agent.id}/prompt_async`;
  const parts = layout ? partsOf(layout) : [{ type: "text", text: text ?? render(message) }];
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parts }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`opencode ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { delivered: true, transport: "http" };
}
