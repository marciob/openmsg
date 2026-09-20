// Some agents keep no record of a session that another program can read.
// Cursor CLI and Gemini CLI are two of them. For those, a hook writes the
// record here each time it runs, and discovery reads this directory.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// The home reads from the environment at each call. A gateway that stands for
// another person therefore reads the records of that person, and not of this
// one.
function dir() {
  return path.join(process.env.OPENMSG_HOME ?? path.join(os.homedir(), ".openmsg"), "agents");
}

// A session that no hook reported for this long is gone from the list.
export const STALE_MS = 6 * 3600 * 1000;

export function register({ vendor, id, name, cwd }) {
  const DIR = dir();
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `${vendor}-${id}.json`.replace(/[^A-Za-z0-9._-]/g, "_"));
  const record = { vendor, id, name, cwd: cwd ?? null, lastSeen: Date.now() };
  fs.writeFileSync(file, JSON.stringify(record, null, 1));
  return record;
}

export function registered({ maxAgeMs = STALE_MS } = {}) {
  const DIR = dir();
  let files = [];
  try {
    files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    let rec;
    try {
      rec = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
    } catch {
      continue;
    }
    if (Date.now() - (rec.lastSeen ?? 0) > maxAgeMs) continue;
    out.push({
      vendor: rec.vendor,
      id: rec.id,
      name: rec.name ?? rec.id.slice(-8),
      pid: null,
      cwd: rec.cwd,
      status: "unknown",
      transport: { kind: "mailbox" },
    });
  }
  return out;
}
