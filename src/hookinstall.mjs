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
  { vendor: "gemini", file: path.join(HOME, ".gemini", "settings.json") },
];

// Versions of openmsg before 0.8 wrote the Gemini hooks to this file, in a
// flat shape. Gemini CLI does not read it. install and uninstall take those
// entries away.
const OLD_GEMINI_FILE = path.join(HOME, ".gemini", "hooks.json");

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
// Gemini CLI reads its hooks from settings.json, in the shape of Claude Code:
// a matcher, then a list of commands. A matcher of a lifecycle event is an
// exact string, so "*" is the one value that matches each source of
// SessionStart. The other hooks and settings of the user stay as they are.
export function geminiConfig(config, command) {
  const next = config ?? {};
  next.hooks = next.hooks ?? {};
  for (const event of ["AfterAgent", "SessionStart"]) {
    const groups = withoutOurs(next.hooks[event] ?? [], "gemini");
    groups.push({
      matcher: "*",
      hooks: [{ name: "openmsg", type: "command", command: `${command} hook gemini`, timeout: 10000 }],
    });
    next.hooks[event] = groups;
  }
  return next;
}

// Claude Code: https://code.claude.com/docs/en/hooks
// Its hooks sit one level deeper: a matcher, then a list of commands. The other
// hooks of the user stay as they are.
function isOurs(h, vendor = "claude") {
  return String(h.command ?? "").includes(MARK) && String(h.command ?? "").includes(`hook ${vendor}`);
}

export function claudeConfig(config, command) {
  const next = config ?? {};
  next.hooks = next.hooks ?? {};
  const groups = withoutOurs(next.hooks.SessionStart ?? [], "claude");
  groups.push({
    matcher: "startup|resume|clear",
    hooks: [{ type: "command", command: `${command} hook claude`, timeout: 10 }],
  });
  next.hooks.SessionStart = groups;
  return next;
}

export function withoutOurs(groups, vendor = "claude") {
  return groups
    .filter((g) => !isOurs(g, vendor))
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h, vendor)) }))
    .filter((g) => g.hooks.length > 0);
}

// The flat entries that an old version wrote to ~/.gemini/hooks.json.
function removeOldGemini() {
  const config = readJson(OLD_GEMINI_FILE);
  if (!config?.hooks) return null;
  let touched = false;
  for (const [event, list] of Object.entries(config.hooks)) {
    if (!Array.isArray(list)) continue;
    const kept = list.filter((h) => !String(h.command ?? "").includes(MARK));
    if (kept.length === list.length) continue;
    touched = true;
    if (kept.length === 0) delete config.hooks[event];
    else config.hooks[event] = kept;
  }
  if (!touched) return null;
  if (Object.keys(config.hooks).length === 0 && Object.keys(config).length === 1) fs.rmSync(OLD_GEMINI_FILE);
  else fs.writeFileSync(OLD_GEMINI_FILE, JSON.stringify(config, null, 2) + "\n");
  return { vendor: "gemini", file: OLD_GEMINI_FILE, action: "removed (old place, Gemini does not read it)" };
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
  const old = removeOldGemini();
  if (old) out.push(old);
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
      const nested = vendor === "claude" || vendor === "gemini";
      const kept = nested
        ? withoutOurs(list, vendor)
        : list.filter((h) => !String(h.command ?? "").includes(MARK));
      if (nested && JSON.stringify(kept) !== JSON.stringify(list)) touched = true;
      if (kept.length !== list.length) touched = true;
      if (kept.length === 0) delete config.hooks[event];
      else config.hooks[event] = kept;
    }
    if (!touched) continue;
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
    out.push({ vendor, file, action: "removed" });
  }
  const old = removeOldGemini();
  if (old) out.push(old);
  return out;
}
