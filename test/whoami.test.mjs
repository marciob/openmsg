// Tests for /whoami in Claude Code: the UserPromptSubmit hook that answers
// with no model call, and the command file that install writes and removes.
// Source: https://code.claude.com/docs/en/hooks
// Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-whoami-"));
process.env.HOME = ROOT;
process.env.OPENMSG_HOME = path.join(ROOT, ".openmsg");
const SESSIONS = path.join(ROOT, ".claude", "sessions");
fs.mkdirSync(SESSIONS, { recursive: true });
const SETTINGS = path.join(ROOT, ".claude", "settings.json");

const { runHook } = await import("../src/hook.mjs");
const { installHooks, uninstallHooks, claudeConfig, withoutOurs, WHOAMI_FILE } = await import("../src/hookinstall.mjs");

async function withStdin(text, fn) {
  const { Readable } = await import("node:stream");
  const real = Object.getOwnPropertyDescriptor(process, "stdin");
  Object.defineProperty(process, "stdin", { value: Readable.from([text]), configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "stdin", real);
  }
}

const prompt = (text, sessionId = "s-whoami") =>
  JSON.stringify({ session_id: sessionId, hook_event_name: "UserPromptSubmit", prompt: text, cwd: ROOT });

fs.writeFileSync(path.join(SESSIONS, "4242.json"), JSON.stringify({ pid: 4242, sessionId: "s-whoami", name: "api-worker" }));

test("/whoami gets the address of the session, and the prompt stops before the model", async () => {
  const out = await withStdin(prompt("  /whoami \n"), () => runHook("claude"));
  assert.deepEqual(out, { decision: "block", reason: "claude:api-worker" });
});

test("another prompt gets nothing, so Claude Code continues as usual", async () => {
  assert.deepEqual(await withStdin(prompt("/whoami please"), () => runHook("claude")), {});
  assert.deepEqual(await withStdin(prompt("fix the tests"), () => runHook("claude")), {});
});

test("a session with no record gets nothing, and the command runs as usual", async () => {
  assert.deepEqual(await withStdin(prompt("/whoami", "s-unknown"), () => runHook("claude")), {});
});

test("install adds one UserPromptSubmit hook, and keeps the hooks of the user", () => {
  const theirs = { hooks: [{ type: "command", command: "~/.claude/hooks/mine.sh" }] };
  const twice = claudeConfig(claudeConfig({ hooks: { UserPromptSubmit: [theirs] } }, "openmsg"), "openmsg");
  assert.equal(twice.hooks.UserPromptSubmit.length, 2);
  assert.equal(twice.hooks.UserPromptSubmit[1].hooks[0].command, "openmsg hook claude");
  assert.equal(twice.hooks.UserPromptSubmit[1].matcher, undefined, "UserPromptSubmit takes no matcher");
  assert.deepEqual(withoutOurs(twice.hooks.UserPromptSubmit), [theirs]);
});

test("install writes the /whoami command, and uninstall removes it", () => {
  const rows = installHooks("openmsg");
  assert.ok(rows.some((r) => r.file === WHOAMI_FILE && r.action === "created"));
  const text = fs.readFileSync(WHOAMI_FILE, "utf8");
  assert.match(text, /^---\n/, "the front matter comes first");
  assert.match(text, /!`openmsg whoami`/);
  assert.ok(installHooks("openmsg").some((r) => r.file === WHOAMI_FILE && r.action === "updated"));
  const settings = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  assert.equal(settings.hooks.UserPromptSubmit.length, 1);
  uninstallHooks();
  assert.equal(fs.existsSync(WHOAMI_FILE), false);
  assert.equal(JSON.parse(fs.readFileSync(SETTINGS, "utf8")).hooks.UserPromptSubmit, undefined);
});

test("a /whoami command that the user wrote stays", () => {
  fs.mkdirSync(path.dirname(WHOAMI_FILE), { recursive: true });
  fs.writeFileSync(WHOAMI_FILE, "my own command\n");
  assert.ok(installHooks("openmsg").some((r) => r.file === WHOAMI_FILE && /skipped/.test(r.action)));
  uninstallHooks();
  assert.equal(fs.readFileSync(WHOAMI_FILE, "utf8"), "my own command\n");
});
