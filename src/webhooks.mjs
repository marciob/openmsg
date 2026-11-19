// The agents that wake on an HTTP request. Such an agent has no session that
// another program can write to. Its owner gives openmsg one URL, and a POST to
// that URL starts a turn of the agent.
//
// The URL is a secret: a person who holds it can wake the agent. The file is
// therefore readable by its owner only, and no command prints the URL in the
// routing data or in `list --json`.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// The home reads from the environment at each call, as the mailbox does.
function file() {
  return path.join(process.env.OPENMSG_HOME ?? path.join(os.homedir(), ".openmsg"), "webhooks.json");
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
  fs.writeFileSync(file(), JSON.stringify(data, null, 1), { mode: 0o600 });
  // The mode of an existing file does not change on a write.
  fs.chmodSync(file(), 0o600);
}

// A name is a part of an address, and of a file name of the mailbox.
const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;

export function add(name, url) {
  if (!NAME.test(String(name ?? ""))) {
    throw new Error(`"${name}" is not a name. Use lowercase letters, digits, ".", "_", and "-"`);
  }
  let address;
  try {
    address = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a URL`);
  }
  if (address.protocol !== "https:" && address.protocol !== "http:") {
    throw new Error(`a webhook takes an http:// or https:// address, and "${url}" is neither`);
  }
  const data = read();
  data[name] = { url: address.href, addedAt: data[name]?.addedAt ?? new Date().toISOString() };
  save(data);
  return { name, ...data[name] };
}

export function remove(name) {
  const data = read();
  if (!data[name]) return false;
  delete data[name];
  save(data);
  return true;
}

// The same shape that discovery gives for a session of a vendor. The name is
// also the id, because one name is one agent, and it has no session.
export function agents() {
  return Object.entries(read()).map(([name, row]) => ({
    vendor: "webhook",
    id: name,
    name,
    pid: null,
    cwd: null,
    status: "waits",
    title: "wakes on an HTTP request",
    startedAt: null,
    updatedAt: null,
    transport: { kind: "webhook", url: row.url },
  }));
}
