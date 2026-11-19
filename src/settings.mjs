// The small file that says where this gateway answers, and which relay this
// owner uses. It lives apart from the gateway, so that every module reads it
// without a circle of imports.
import fs from "node:fs";
import path from "node:path";
import { home } from "./identity.mjs";

function file() {
  return path.join(home(), "gateway.json");
}

export function settings() {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8"));
  } catch {
    return {};
  }
}

export function saveSettings(next) {
  const target = file();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const data = { ...settings(), ...next, updatedAt: new Date().toISOString() };
  fs.writeFileSync(target, JSON.stringify(data, null, 1) + "\n");
  return data;
}

// The address that this owner gives to other people, in an invitation, in the
// directory, and in the routing data. A loopback address means this machine
// alone. A gateway that listens there and uses a relay gives no address,
// because the relay is its way in. With that address in the directory, a
// sender on another machine writes to its own machine, and never to the relay.
const LOOPBACK = ["127.0.0.1", "localhost", "::1", "[::1]"];

export function advertised() {
  const { endpoint, relay } = settings();
  if (!endpoint) return null;
  let host;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    return null;
  }
  return relay && LOOPBACK.includes(host) ? null : endpoint;
}

export function endpointFor(host, port) {
  const name = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${name}:${port}`;
}
