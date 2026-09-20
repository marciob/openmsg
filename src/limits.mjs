// The limits of the receiver. The `hops` list of a sender is not enough,
// because a sender writes that list itself.
//
// Three limits: how many messages one sender sends in a window, how many turns
// remote messages start in one session, and how many messages wait for the
// owner. The owner changes a value in `$OPENMSG_HOME/limits.json`.
import fs from "node:fs";
import path from "node:path";
import { home } from "./identity.mjs";

export const DEFAULTS = {
  // Messages from one sender, in one project, inside the window.
  senderPerWindow: 30,
  senderWindowMs: 5 * 60_000,
  // Turns that remote messages start in one session, inside the window. Above
  // this number a message waits for the owner, and no work is lost.
  turnsPerSession: 10,
  turnWindowMs: 10 * 60_000,
  // Messages that wait for the owner, over every project.
  heldMax: 100,
};

export function values() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(home(), "limits.json"), "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

function since(rows, ms, now) {
  return rows.filter((r) => now - Date.parse(r.receivedAt ?? r.at ?? 0) < ms);
}

// It gives null when the message passes every limit, and a reason when one
// limit stops it. "hold" means that the message waits for the owner instead.
export function check(rows, { owner, project, session, now = Date.now(), limits = values() } = {}) {
  const fromSender = since(rows.filter((r) => r.from?.owner === owner && r.project === project), limits.senderWindowMs, now);
  if (fromSender.length >= limits.senderPerWindow) {
    return {
      action: "refuse",
      reason: "rate-limit",
      detail: `${owner} sent ${fromSender.length} messages in ${Math.round(limits.senderWindowMs / 60_000)} minutes`,
    };
  }
  const held = rows.filter((r) => r.status === "held");
  if (held.length >= limits.heldMax) {
    return { action: "refuse", reason: "queue-full", detail: `${held.length} messages wait for the owner` };
  }
  const started = since(
    rows.filter((r) => r.target?.session === session && ["adapter-accepted", "agent-acknowledged", "replied"].includes(r.status)),
    limits.turnWindowMs,
    now,
  );
  if (started.length >= limits.turnsPerSession) {
    return {
      action: "hold",
      reason: "turn-limit",
      detail: `remote messages started ${started.length} turns in that session in ${Math.round(limits.turnWindowMs / 60_000)} minutes`,
    };
  }
  return null;
}
