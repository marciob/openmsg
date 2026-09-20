// The sessions that this owner publishes. The default is that nothing is
// published, and a session reaches the network only after `openmsg publish`.
//
// The epoch belongs to the alias. A name can move to a new session, and the
// epoch counts that move. A message for an old epoch is refused, so a message
// never lands in a session that took the name later.
import fs from "node:fs";
import path from "node:path";
import { home } from "./identity.mjs";

function file() {
  return path.join(home(), "published.json");
}

export function read() {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8"));
  } catch {
    return { version: 2, projects: {} };
  }
}

function save(data) {
  const target = file();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1) + "\n");
  fs.renameSync(tmp, target);
}

export function aliasOf(agent) {
  return `${agent.vendor}:${agent.name ?? agent.id}`;
}

export function publish(projectId, agent) {
  const data = read();
  const project = data.projects[projectId] ?? {};
  const alias = aliasOf(agent);
  const before = project[alias];
  const record = {
    alias,
    vendor: agent.vendor,
    name: agent.name ?? agent.id,
    session: agent.id,
    // A new session under one name is a new epoch.
    epoch: before && before.session !== agent.id ? before.epoch + 1 : (before?.epoch ?? 1),
    publishedAt: new Date().toISOString(),
  };
  project[alias] = record;
  data.projects[projectId] = project;
  save(data);
  return record;
}

export function unpublish(projectId, alias) {
  const data = read();
  const project = data.projects[projectId];
  if (!project?.[alias]) return null;
  const gone = project[alias];
  delete project[alias];
  save(data);
  return gone;
}

export function list(projectId = null) {
  const data = read();
  const out = [];
  for (const [id, project] of Object.entries(data.projects)) {
    if (projectId && id !== projectId) continue;
    for (const record of Object.values(project)) out.push({ project: id, ...record });
  }
  return out;
}

export function find(projectId, { alias = null, session = null }) {
  return list(projectId).find((r) => (alias ? r.alias === alias : true) && (session ? r.session === session : true)) ?? null;
}
