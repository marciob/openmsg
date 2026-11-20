// The identities on other machines that belong to the owner of this machine,
// such as a hosted bot that the owner talks to from a phone. The bot has its
// own keys, so the directory holds it as another person. The owner can say
// that a request from it counts as a request of the owner, as for a chat of
// section 7.2 of the spec of 0.1.
//
// Only a command of the owner sets the mark. No message changes this file.
import fs from "node:fs";
import path from "node:path";
import { home } from "./identity.mjs";

function file() {
  return path.join(home(), "voice-owners.json");
}

function read() {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8"));
  } catch {
    return {};
  }
}

function save(data) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(data, null, 1) + "\n", { mode: 0o600 });
}

export function set(ownerId, label, on) {
  const data = read();
  if (on) data[ownerId] = { label, at: new Date().toISOString() };
  else delete data[ownerId];
  save(data);
}

export function speaksForOwner(ownerId) {
  return Boolean(ownerId && read()[ownerId]);
}

export function list() {
  return Object.entries(read()).map(([ownerId, row]) => ({ ownerId, ...row }));
}
