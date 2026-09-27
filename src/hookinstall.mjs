// `openmsg install --hooks` writes the hook that delivers a message to an agent
// with no push entry point. Cursor CLI and Gemini CLI are those agents.
//
// The hook runs at the end of a turn. It registers the session, and it gives
// the waiting messages to the agent.
//
// Claude Code gets a SessionStart hook. It gives the project messages of the
// working directory to a new session.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = os.homedir();
const MARK = "openmsg";

export const HOOK_TARGETS = [
  { vendor: "claude", file: path.join(HOME, ".claude", "settings.json") },
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

// Claude Code: https://code.claude.com/docs/en/hooks
// Its hooks sit one level deeper: a matcher, then a list of commands. The other
// hooks of the user stay as they are.
function isOurs(h) {
  return String(h.command ?? "").includes(MARK) && String(h.command ?? "").includes("hook claude");
}

export function claudeConfig(config, command) {
  const next = config ?? {};
  next.hooks = next.hooks ?? {};
  const groups = withoutOurs(next.hooks.SessionStart ?? []);
  groups.push({
    matcher: "startup|resume|clear",
    hooks: [{ type: "command", command: `${command} hook claude`, timeout: 10 }],
  });
  next.hooks.SessionStart = groups;
  return next;
}

export function withoutOurs(groups) {
  return groups
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
    .filter((g) => g.hooks.length > 0);
}

export function installHooks(command) {
  const out = [];
  for (const { vendor, file } of HOOK_TARGETS) {
    if (!fs.existsSync(path.dirname(file))) {
      out.push({ vendor, file, action: "skipped (agent not installed)" });
      continue;
    }
    const before = readJson(file);
    // A file that exists and does not parse belongs to the user. openmsg
    // never writes over it.
    if (before === null && fs.existsSync(file)) {
      out.push({ vendor, file, action: "skipped (not valid JSON)" });
      continue;
    }
    const configOf = { claude: claudeConfig, cursor: cursorConfig, gemini: geminiConfig }[vendor];
    const after = configOf(before, command);
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
      const kept = vendor === "claude"
        ? withoutOurs(list)
        : list.filter((h) => !String(h.command ?? "").includes(MARK));
      if (vendor === "claude" && JSON.stringify(kept) !== JSON.stringify(list)) touched = true;
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
