// Adapter: OpenCode.
// The OpenCode user interface is a client of a local HTTP server. Any program
// can send a prompt to a session with one request.
// Source: https://opencode.ai/docs/server/
import { render } from "../envelope.mjs";

export async function deliver(agent, message) {
  const url = `${agent.transport.base}/session/${agent.id}/prompt_async`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text: render(message) }] }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`opencode ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { delivered: true, transport: "http" };
}
