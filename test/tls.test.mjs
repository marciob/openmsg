// Tests for the TLS of the relay. Rule 4.2 of the spec asks for it: the body
// of a message is sealed, and the addresses on the outside are not.
// Run: node --test
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-tls-"));
const RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-tlsr-"));
process.env.OPENMSG_RELAY_HOME = RELAY_HOME;
process.env.OPENMSG_HOME = HOME;

const identity = await import("../src/identity.mjs");
const relay = await import("../src/relay.mjs");
const relaylink = await import("../src/relaylink.mjs");
const { saveSettings } = await import("../src/settings.mjs");

identity.create({ label: "alice" });

// A certificate for 127.0.0.1, made here. A machine without openssl skips
// the two tests that need one.
function selfSigned() {
  const key = path.join(HOME, "relay.key");
  const cert = path.join(HOME, "relay.crt");
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", key, "-out", cert, "-days", "1",
      "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1",
    ], { stdio: "ignore" });
    return { key, cert };
  } catch {
    return null;
  }
}
const pair = selfSigned();

test("a relay that other machines reach refuses to start without TLS", async () => {
  await assert.rejects(relay.serve({ port: 0, host: "0.0.0.0" }), /has no TLS/);
  // The operator says the word, and then it starts.
  const open = await relay.serve({ port: 0, host: "0.0.0.0", insecure: true });
  assert.match(open.url, /^ws:\/\//);
  await open.close();
  // On this machine alone, no certificate is needed.
  const local = await relay.serve({ port: 0, host: "127.0.0.1" });
  assert.match(local.url, /^ws:\/\/127\.0\.0\.1:/);
  await local.close();
});

test("a gateway refuses a relay on another machine without TLS", async () => {
  // The guard answers before any connection leaves this machine.
  await assert.rejects(relaylink.open("ws://relay.example.com:7800"), /has no TLS/);
  saveSettings({ relayInsecure: true });
  await assert.rejects(relaylink.open("ws://127.0.0.1:1"), /did not answer/);
  saveSettings({ relayInsecure: false });
});

test("a relay with a certificate speaks wss, and a gateway reaches it", { skip: pair ? false : "openssl is not here" }, async () => {
  const running = await relay.serve({ port: 0, host: "127.0.0.1", cert: pair.cert, key: pair.key });
  after(() => running.close());
  assert.match(running.url, /^wss:\/\/127\.0\.0\.1:/);

  // Without the certificate of that relay, the connection fails.
  saveSettings({ relayCa: null });
  await assert.rejects(relaylink.open(running.url), /did not answer|self-signed|unable to verify/i);

  // With it, the hello and the welcome go through.
  saveSettings({ relayCa: pair.cert });
  const link = await relaylink.open(running.url);
  assert.equal(link.welcome.type, "welcome");
  assert.equal(link.owner, identity.load().ownerId);
  link.close();
});

test("a message travels over the sealed connection", { skip: pair ? false : "openssl is not here" }, async () => {
  const running = await relay.serve({ port: 0, host: "127.0.0.1", cert: pair.cert, key: pair.key });
  after(() => running.close());
  saveSettings({ relayCa: pair.cert });
  const link = await relaylink.open(running.url);
  const me = identity.load();
  const wire = {
    kind: "sealed",
    version: 2,
    messageId: "over-tls",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    from: { owner: me.ownerId },
    project: { id: "p_tls" },
    target: { owner: "o_12345678", project: "p_tls" },
    seal: { alg: "X25519-HKDF-SHA256-AES-256-GCM", epk: "x", iv: "x", ct: "x" },
  };
  const answer = await link.send(wire);
  assert.equal(answer.type, "stored");
  assert.equal(relay.queued("o_12345678").length, 1);
  link.close();
});
