// Tests for the hooks of Gemini CLI: the place and the shape that Gemini
// reads, the settings of the user that stay, the entries of an old version
// that go away, and the answer of the SessionStart hook.
// Source: https://geminicli.com/docs/hooks/reference/
// Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-gemini-"));
process.env.HOME = ROOT;
process.env.OPENMSG_HOME = path.join(ROOT, ".openmsg");
fs.mkdirSync(path.join(ROOT, ".gemini"), { recursive: true });
const SETTINGS = path.join(ROOT, ".gemini", "settings.json");
const OLD = path.join(ROOT, ".gemini", "hooks.json");

const { installHooks, uninstallHooks, geminiConfig } = await import("../src/hookinstall.mjs");

const theirs = { matcher: "write_file", hooks: [{ name: "lint", type: "command", command: "./lint.sh" }] };

test("install writes the hooks to settings.json, in the shape of Gemini, and keeps the settings of the user", () => {
  fs.writeFileSync(SETTINGS, JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } }, hooks: { BeforeTool: [theirs] } }));
  fs.writeFileSync(OLD, JSON.stringify({ hooks: { AfterAgent: [{ command: "openmsg hook gemini", type: "command", timeout: 10 }] } }));
  const rows = installHooks("openmsg");
  assert.ok(rows.some((r) => r.vendor === "gemini" && r.file === SETTINGS && r.action === "updated"));
  assert.ok(rows.some((r) => r.file === OLD && /old place/.test(r.action)));
  assert.equal(fs.existsSync(OLD), false, "the old file held only openmsg, so it is gone");

  const config = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  assert.equal(config.security.auth.selectedType, "oauth-personal");
  assert.deepEqual(config.hooks.BeforeTool, [theirs]);
  for (const event of ["AfterAgent", "SessionStart"]) {
    assert.equal(config.hooks[event].length, 1);
    const [group] = config.hooks[event];
    assert.equal(group.matcher, "*");
    assert.equal(group.hooks[0].command, "openmsg hook gemini");
    assert.equal(group.hooks[0].type, "command");
    // Gemini measures the timeout in milliseconds.
    assert.ok(group.hooks[0].timeout >= 1000);
  }
});

test("a second install gives one entry, and uninstall takes only the entries of openmsg", () => {
  const twice = geminiConfig(geminiConfig({ hooks: { AfterAgent: [theirs] } }, "openmsg"), "openmsg");
  assert.equal(twice.hooks.AfterAgent.length, 2);
  assert.deepEqual(twice.hooks.AfterAgent[0], theirs);

  installHooks("openmsg");
  uninstallHooks();
  const config = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  assert.deepEqual(config.hooks, { BeforeTool: [theirs] });
  assert.equal(config.security.auth.selectedType, "oauth-personal");
});

test("the SessionStart hook gives the text in hookSpecificOutput.additionalContext", async () => {
  const { runHook } = await import("../src/hook.mjs");
  const mailbox = await import("../src/mailbox.mjs");
  const { createMessage } = await import("../src/envelope.mjs");
  const agent = { vendor: "gemini", id: "sess-gem-1", name: `${path.basename(ROOT)}-em-1`, cwd: ROOT };
  mailbox.put(agent, createMessage({ from: { vendor: "claude", id: "c1", name: "web-1" }, to: agent, text: "MARKER-GEMINI-START" }), "queued");
  const input = JSON.stringify({ hook_event_name: "SessionStart", session_id: "sess-gem-1", cwd: ROOT, source: "startup" });
  const { Readable } = await import("node:stream");
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin");
  Object.defineProperty(process, "stdin", { value: Readable.from([input]), configurable: true });
  let out;
  try {
    out = await runHook("gemini");
  } finally {
    Object.defineProperty(process, "stdin", stdin);
  }
  assert.equal(out.hookSpecificOutput?.hookEventName, "SessionStart");
  assert.match(out.hookSpecificOutput.additionalContext, /MARKER-GEMINI-START/);
  assert.equal(out.additional_context, undefined);
});
