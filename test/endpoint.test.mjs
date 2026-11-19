// Tests for the address that an owner gives to other people.
// Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-ep-"));
process.env.OPENMSG_HOME = HOME;
const { saveSettings, advertised } = await import("../src/settings.mjs");
const identity = await import("../src/identity.mjs");
const invite = await import("../src/invite.mjs");
const dirsync = await import("../src/dirsync.mjs");

test("a gateway with no address gives no address", () => {
  assert.equal(advertised(), null);
});

test("a loopback address with no relay is an address, for two people on one machine", () => {
  saveSettings({ endpoint: "http://127.0.0.1:7801", relay: null });
  assert.equal(advertised(), "http://127.0.0.1:7801");
});

test("a loopback address with a relay is no address for another machine", () => {
  for (const endpoint of ["http://127.0.0.1:7801", "http://localhost:7801", "http://[::1]:7801"]) {
    saveSettings({ endpoint, relay: "ws://100.64.0.1:7800" });
    assert.equal(advertised(), null, endpoint);
  }
});

test("an address on a network stays, with a relay or without one", () => {
  saveSettings({ endpoint: "http://100.64.0.2:7801", relay: "ws://100.64.0.1:7800" });
  assert.equal(advertised(), "http://100.64.0.2:7801");
});

test("the record of the directory carries no loopback address to the relay", () => {
  identity.create({ label: "carol" });
  saveSettings({ endpoint: "http://127.0.0.1:7801", relay: "ws://100.64.0.1:7800" });
  const offer = invite.create({ label: "web-app", endpoint: advertised() });
  const records = [dirsync.selfRecord(offer.project.id), dirsync.rosterRecord(offer.project.id)];
  assert.ok(records.length > 0);
  assert.doesNotMatch(JSON.stringify(records), /127\.0\.0\.1/);
  assert.doesNotMatch(Buffer.from(offer.token.split(".")[1], "base64url").toString(), /127\.0\.0\.1/);
});
