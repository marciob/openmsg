// Tests for a message to the own session: `list` marks the row of the caller,
// and `send` refuses to deliver to it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-self-"));
const sessions = path.join(HOME, ".claude", "sessions");
fs.mkdirSync(sessions, { recursive: true });

// Two Claude sessions in one directory. This test process is alive, so its pid
// makes each record a live session. No socket exists, so no delivery can happen.
for (const [id, name] of [["11111111-aaaa", "degen-99"], ["22222222-bbbb", "degen-41"]]) {
  fs.writeFileSync(
    path.join(sessions, `${id}.json`),
    JSON.stringify({ sessionId: id, name, pid: process.pid, cwd: HOME, messagingSocketPath: path.join(HOME, `${id}.sock`) }),
  );
}

function cli(...args) {
  const env = { ...process.env, HOME, OPENMSG_HOME: path.join(HOME, ".openmsg"), OPENMSG_SELF: "claude:degen-99" };
  delete env.CLAUDE_CODE_MESSAGING_SOCKET;
  delete env.CODEX_THREAD_ID;
  return spawnSync("node", [CLI, ...args], { env, encoding: "utf8" });
}

test("list marks the row of the caller with (you), and no other row", () => {
  const out = cli("list").stdout.split("\n");
  const own = out.find((l) => l.startsWith("claude:degen-99"));
  const other = out.find((l) => l.startsWith("claude:degen-41"));
  assert.match(own, /\(you\)$/);
  assert.doesNotMatch(other, /\(you\)/);
});

test("list --json gives you: true only for the caller", () => {
  const rows = JSON.parse(cli("list", "--json").stdout).filter((a) => a.vendor === "claude");
  assert.deepEqual(
    rows.map((a) => [a.name, a.you]).sort(),
    [["degen-41", false], ["degen-99", true]],
  );
});

test("send to the own session fails, and the mailbox stays empty", () => {
  const r = cli("send", "claude:degen-99", "heads-up");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /claude:degen-99 is this session/);
  assert.equal(fs.existsSync(path.join(HOME, ".openmsg", "inbox", "claude%3Adegen-99.jsonl")), false);
});
