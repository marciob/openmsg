// Adapter: Claude Code.
// Each Claude Code session listens on a Unix socket. A script writes two lines
// to it: an auth line, then the message. The session delivers the message to its
// model. An idle session starts a new turn. A busy session reads the message
// between two tool calls.
// Source: https://code.claude.com/docs/en/cross-session-messaging
import net from "node:net";
import { render } from "../envelope.mjs";

export async function deliver(agent, message, { token, text = null } = {}) {
  const socketPath = agent.transport.path;
  const lines = [];
  if (token) lines.push(JSON.stringify({ type: "auth", token }));
  lines.push(
    JSON.stringify({
      type: "user",
      message: { role: "user", content: text ?? render(message) },
    }),
  );

  await new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    const fail = (e) => {
      sock.destroy();
      reject(new Error(`claude socket ${socketPath}: ${e.message}`));
    };
    sock.setTimeout(5000, () => fail(new Error("timeout")));
    sock.on("error", fail);
    sock.on("connect", () => {
      sock.end(lines.join("\n") + "\n", () => resolve());
    });
  });

  return { delivered: true, transport: "uds" };
}
