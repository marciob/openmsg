// The project box keeps a message to a directory, until a session in that
// directory takes it. A program with no session, such as a scheduled check,
// sends to "project:<dir>". The message waits on disk, so it survives the end
// of every session and a restart of the machine.
//
// One file for each waiting message. A session takes a message with a rename,
// and a rename is atomic, so two sessions never take the same message.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { encodeName } from "./mailbox.mjs";

export const PREFIX = "project:";

// A message that nobody took in this time is gone at the next read.
export const EXPIRE_MS = 30 * 24 * 3600 * 1000;

function root() {
  return path.join(process.env.OPENMSG_HOME ?? path.join(os.homedir(), ".openmsg"), "projects");
}

function boxOf(dir) {
  return path.join(root(), encodeName(dir));
}

// The real path, so "~/dev/x", "./x" and a symbolic link give one project.
export function resolveDir(dir) {
  const full = path.resolve(dir.replace(/^~(?=$|\/)/, os.homedir()));
  try {
    return fs.realpathSync(full);
  } catch {
    throw new Error(`no directory ${full}`);
  }
}

export function isProjectAddress(target) {
  return typeof target === "string" && target.startsWith(PREFIX);
}

export function dirOfAddress(target) {
  return resolveDir(target.slice(PREFIX.length));
}

// A message with a key replaces the waiting message with that key.
function fileName(message) {
  const key = message.openmsg?.key;
  return key ? `key-${encodeName(key)}.json` : `${message.messageId}.json`;
}

export function put(dir, message) {
  const box = boxOf(dir);
  fs.mkdirSync(box, { recursive: true });
  const file = path.join(box, fileName(message));
  // Write, then rename. A reader never sees half a file, and a key replaces
  // the old message in one step.
  const tmp = path.join(box, `.tmp-${message.messageId}`);
  fs.writeFileSync(tmp, JSON.stringify(message));
  fs.renameSync(tmp, file);
  return file;
}

export function clear(dir, key) {
  try {
    fs.unlinkSync(path.join(boxOf(dir), `key-${encodeName(key)}.json`));
    return true;
  } catch {
    return false;
  }
}

function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function expired(message) {
  return Date.now() - Date.parse(message.createdAt ?? 0) > EXPIRE_MS;
}

// The waiting files of one project, oldest first. An expired message goes away.
function files(dir) {
  const box = boxOf(dir);
  let names = [];
  try {
    names = fs.readdirSync(box).filter((n) => n.endsWith(".json") && !n.startsWith("."));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const file = path.join(box, name);
    const message = read(file);
    if (!message) continue;
    if (expired(message)) {
      fs.rmSync(file, { force: true });
      continue;
    }
    out.push({ file, message });
  }
  return out.sort((a, b) => String(a.message.createdAt).localeCompare(String(b.message.createdAt)));
}

export function waiting(dir) {
  return files(dir).map((f) => f.message);
}

// Every project with a waiting message.
export function all() {
  let names = [];
  try {
    names = fs.readdirSync(root());
  } catch {
    return [];
  }
  return names
    .map((n) => decodeURIComponent(n))
    .map((dir) => ({ dir, messages: waiting(dir) }))
    .filter((p) => p.messages.length > 0);
}

function realOf(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return null;
  }
}

function inside(real, dir) {
  return real === dir || real.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

// A session is in a project when its working directory is the project, or a
// directory inside it.
export function sessionIsIn(cwd, dir) {
  const real = cwd ? realOf(cwd) : null;
  return real !== null && inside(real, dir);
}

// The projects that hold this working directory.
export function projectsOf(cwd) {
  const real = realOf(cwd);
  if (!real) return [];
  let names = [];
  try {
    names = fs.readdirSync(root());
  } catch {
    return [];
  }
  return names.map((n) => decodeURIComponent(n)).filter((dir) => inside(real, dir));
}

// Take one waiting file. The rename succeeds for one caller only. The others
// get null.
function takeFile(dir, file) {
  const taken = path.join(boxOf(dir), "taken");
  fs.mkdirSync(taken, { recursive: true });
  const message = read(file);
  if (!message) return null;
  const target = path.join(taken, `${message.messageId}.json`);
  try {
    fs.renameSync(file, target);
  } catch {
    return null;
  }
  // A sender can replace a keyed file between the read and the rename. The
  // file that moved is the one to deliver.
  return { message: read(target) ?? message, target };
}

// Take every waiting message for a session in this working directory.
export function take(cwd) {
  const out = [];
  for (const dir of projectsOf(cwd)) {
    for (const { file } of files(dir)) {
      const got = takeFile(dir, file);
      if (got) out.push({ dir, ...got });
    }
  }
  return out;
}

// Take the message that the sender just kept, for delivery to a live session.
export function takeMessage(dir, message) {
  return takeFile(dir, path.join(boxOf(dir), fileName(message)));
}

// Delivery failed after the take. The message waits again, unless a newer
// message with the same key took its place.
export function restore(dir, got) {
  const file = path.join(boxOf(dir), fileName(got.message));
  if (fs.existsSync(file)) {
    fs.rmSync(got.target, { force: true });
    return;
  }
  fs.renameSync(got.target, file);
}
