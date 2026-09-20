// `openmsg install --hooks` writes the hook that delivers a message to an agent
// with no push entry point. Cursor CLI and Gemini CLI are those agents.
//
// The hook runs at the end of a turn. It registers the session, and it gives
// the waiting messages to the agent.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = os.homedir();
const MARK = "openmsg";

export const HOOK_TARGETS = [
  { vendor: "cursor", file: path.join(HOME, ".cursor", "hooks.json") },
  { vendor: "gemini", file: path.join(HOME, ".gemini", "hooks.json") },
];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Cursor: https://cursor.com/docs/hooks
function cursorConfig(config, command) {
  const next = config ?? { version: 1, hooks: {} };
  next.hooks = next.hooks ?? {};
  for (const event of ["stop", "sessionStart"]) {
    const list = (next.hooks[event] ?? []).filter((h) => !String(h.command ?? "").includes(MARK));
    list.push({ command: `${command} hook cursor`, type: "command", timeout: 10 });
    next.hooks[event] = list;
  }
  return next;
}

// Gemini: https://geminicli.com/docs/hooks/reference/
function geminiConfig(config, command) {
  const next = config ?? { hooks: {} };
  next.hooks = next.hooks ?? {};
  for (const event of ["AfterAgent", "SessionStart"]) {
    const list = (next.hooks[event] ?? []).filter((h) => !String(h.command ?? "").includes(MARK));
    list.push({ command: `${command} hook gemini`, type: "command", timeout: 10 });
    next.hooks[event] = list;
  }
  return next;
}

export function installHooks(command) {
  const out = [];
  for (const { vendor, file } of HOOK_TARGETS) {
    if (!fs.existsSync(path.dirname(file))) {
      out.push({ vendor, file, action: "skipped (agent not installed)" });
      continue;
    }
    const before = readJson(file);
    const after = vendor === "cursor" ? cursorConfig(before, command) : geminiConfig(before, command);
    fs.writeFileSync(file, JSON.stringify(after, null, 2) + "\n");
    out.push({ vendor, file, action: before ? "updated" : "created" });
  }
  return out;
}

export function uninstallHooks() {
  const out = [];
  for (const { vendor, file } of HOOK_TARGETS) {
    const config = readJson(file);
    if (!config?.hooks) continue;
    let touched = false;
    for (const [event, list] of Object.entries(config.hooks)) {
      if (!Array.isArray(list)) continue;
      const kept = list.filter((h) => !String(h.command ?? "").includes(MARK));
      if (kept.length !== list.length) touched = true;
      if (kept.length === 0) delete config.hooks[event];
      else config.hooks[event] = kept;
    }
    if (!touched) continue;
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
    out.push({ vendor, file, action: "removed" });
  }
  return out;
}
