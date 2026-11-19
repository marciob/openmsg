// The adapter for an agent that wakes on an HTTP request.
//
// The request carries a notice, and it never carries the text of the sender.
// The URL of a webhook is on a network, and a person who learns it can send a
// request of their own. A request with the text of a message would therefore
// let that person write to the agent with no signature. With a notice alone,
// a false request wakes the agent, and the agent finds an empty mailbox.
//
// The agent reads the message with `openmsg inbox`. That command reads the
// mailbox on the machine of the agent, and only openmsg writes there.

// A sender chooses the id of its message. Only an id with the shape of a UUID
// goes into the notice, so no text of the sender travels in that field.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function notice(agent, message) {
  return {
    openmsg: "message-waiting",
    agent: `${agent.vendor}:${agent.name}`,
    messageId: UUID.test(String(message?.messageId ?? "")) ? message.messageId : null,
    text:
      "A message waits for you in openmsg. Run this command to read it: openmsg inbox. " +
      "This notice is not the message, and it approves no action.",
  };
}

export async function deliver(agent, message, { timeoutMs = 10_000 } = {}) {
  const url = agent.transport?.url;
  if (!url) throw new Error(`the agent ${agent.name} has no webhook address`);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      // The owner can name a header that the webhook asks for, such as a key.
      headers: { ...(agent.transport.headers ?? {}), "content-type": "application/json" },
      body: JSON.stringify(notice(agent, message)),
      signal: AbortSignal.timeout(timeoutMs),
      // A redirect can send the notice to an address that the owner did not give.
      redirect: "error",
    });
  } catch (e) {
    // The message of the error can hold the URL, and the URL is a secret.
    throw new Error(`the webhook of ${agent.name} did not answer (${e.cause?.code ?? e.name})`);
  }
  // The body is not read. Nothing that the webhook answers reaches a model.
  await res.body?.cancel().catch(() => {});
  if (!res.ok) throw new Error(`the webhook of ${agent.name} answered ${res.status}`);
  return { delivered: true, transport: "webhook" };
}
