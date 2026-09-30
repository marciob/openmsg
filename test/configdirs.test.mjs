// Tests for Claude Code sessions that keep their state outside ~/.claude, in
// the directory that CLAUDE_CONFIG_DIR names.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-configdirs-"));

// One session in ~/.claude, one in ~/.claude-work, and one in a directory
// outside the home directory that only CLAUDE_CONFIG_DIR names. This test
// process is alive, and it is the parent of each command, so its pid makes
// each record a live session that runs the command.
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-config-"));
const records = [
  [path.join(HOME, ".claude"), "aaaa-1111", "main-11"],
  [path.join(HOME, ".claude-work"), "bbbb-2222", "work-22"],
  [OUTSIDE, "cccc-3333", "outside-33"],
];
for (const [config, id, name] of records) {
  fs.mkdirSync(path.join(config, "sessions"), { recursive: true });
  fs.writeFileSync(
    path.join(config, "sessions", `${id}.json`),
    JSON.stringify({ sessionId: id, name, pid: process.pid, cwd: HOME, messagingSocketPath: path.join(HOME, `${id}.sock`) }),
  );
}

function cli(env, ...args) {
  const base = { ...process.env, HOME, OPENMSG_HOME: path.join(HOME, ".openmsg") };
  for (const k of ["OPENMSG_SELF", "CLAUDE_CODE_MESSAGING_SOCKET", "CODEX_THREAD_ID", "CLAUDE_CONFIG_DIR"]) delete base[k];
  return spawnSync("node", [CLI, ...args], { env: { ...base, ...env }, encoding: "utf8" });
}

test("list shows the sessions of ~/.claude and of each ~/.claude-* directory", () => {
  const out = cli({}, "list", "--all").stdout;
  assert.match(out, /^claude:main-11 /m);
  assert.match(out, /^claude:work-22 /m);
  assert.doesNotMatch(out, /outside-33/);
});

test("list shows the sessions of the directory that CLAUDE_CONFIG_DIR names", () => {
  const out = cli({ CLAUDE_CONFIG_DIR: OUTSIDE }, "list", "--all").stdout;
  assert.match(out, /^claude:outside-33 /m);
});

test("whoami finds a session of ~/.claude-work by its socket", () => {
  const r = cli({ CLAUDE_CODE_MESSAGING_SOCKET: path.join(HOME, "bbbb-2222.sock") }, "whoami");
  assert.equal(r.stdout.trim(), "claude:work-22");
});

test("whoami refuses a false shell name when no record holds the socket", () => {
  const r = cli({ CLAUDE_CODE_MESSAGING_SOCKET: path.join(HOME, "missing.sock") }, "whoami");
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout, /shell:/);
  assert.match(r.stderr, /cannot find the record of that session/);
});
