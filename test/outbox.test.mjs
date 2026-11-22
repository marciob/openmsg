// The outbox of the sender: the order of the states, and the note for a
// message that no agent read.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-outbox-"));
process.env.OPENMSG_HOME = HOME;
const outbox = await import("../src/outbox.mjs");

after(() => fs.rmSync(HOME, { recursive: true, force: true }));

test("a receipt never moves the state of a message back", () => {
  outbox.put({ messageId: "m-order", to: "o_x", alias: "bot@x", state: "queued" });
  assert.equal(outbox.advance("m-order", "replied").written, true);
  // The relay kept an older receipt, and it gives it on a new connection.
  assert.equal(outbox.advance("m-order", "agent-acknowledged").written, false);
  assert.equal(outbox.advance("m-order", "adapter-accepted").written, false);
  assert.equal(outbox.find("m-order").state, "replied");
  // The same state again writes nothing.
  assert.equal(outbox.advance("m-order", "replied").written, false);
  // A state outside the order is always written.
  assert.equal(outbox.advance("m-order", "refused", { reason: "expired" }).written, true);
  assert.equal(outbox.find("m-order").state, "refused");
});

test("a message for another machine gives no row", () => {
  assert.equal(outbox.advance("m-nobody", "adapter-accepted"), null);
});

test("a message that reached the adapter and that no agent read gets a note", () => {
  outbox.put({ messageId: "m-quiet-0001", to: "o_x", alias: "grokbot@grok", state: "adapter-accepted" });
  outbox.put({ messageId: "m-read-0001", to: "o_x", alias: "grokbot@grok", state: "agent-acknowledged" });
  const now = Date.now();
  assert.equal(outbox.silent({ now }).length, 0, "a new message is not silent yet");
  const later = now + outbox.SILENT_MS + 1000;
  const quiet = outbox.silent({ now: later });
  assert.deepEqual(quiet.map((r) => r.messageId), ["m-quiet-0001"]);
  assert.equal(outbox.silent({ now: later, alias: "other@grok" }).length, 0, "the filter by address holds");
  assert.equal(outbox.silent({ now: now + 25 * 3600 * 1000 }).length, 0, "an old message gives no note");
  const note = outbox.silenceNote(quiet[0], { now: later });
  assert.match(note, /^m-quiet- to grokbot@grok reached the agent 5 min ago/);
  assert.match(note, /busy, or out of credits/);
});
