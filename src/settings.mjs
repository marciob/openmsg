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

export function endpointFor(host, port) {
  const name = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${name}:${port}`;
}
