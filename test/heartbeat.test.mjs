// A test for the connection that stops with no sign. A small TCP proxy stands
// between the gateway and the relay. It can keep each socket open and carry
// nothing, as a network does when the far machine sleeps.
// Run: node --test
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

process.env.OPENMSG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-hb-"));
process.env.OPENMSG_RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-hbr-"));
const identity = await import("../src/identity.mjs");
const relay = await import("../src/relay.mjs");
const relaylink = await import("../src/relaylink.mjs");

identity.create({ label: "dana" });
const running = await relay.serve({ port: 0, host: "127.0.0.1" });
const relayPort = Number(new URL(running.url).port);

const pairs = [];
const proxy = net.createServer((near) => {
  const far = net.connect(relayPort, "127.0.0.1");
  near.pipe(far);
  far.pipe(near);
  near.on("error", () => {});
  far.on("error", () => {});
  pairs.push({ near, far });
});
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const PROXY_URL = `ws://127.0.0.1:${proxy.address().port}`;

// The sockets stay open, and no byte passes in either direction.
function goSilent() {
  for (const { near, far } of pairs) {
    near.unpipe(far);
    far.unpipe(near);
    near.pause();
    far.pause();
  }
}

let holder = null;
after(async () => {
  holder?.stop();
  for (const { near, far } of pairs) {
    near.destroy();
    far.destroy();
  }
  await new Promise((resolve) => proxy.close(resolve));
  await running.close();
});

const until = async (check, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

test("a relay that goes silent, with no FIN, is dropped, and the gateway connects again", async () => {
  let opened = 0;
  let closed = 0;
  holder = await relaylink.keep(PROXY_URL, { onOpen: () => (opened += 1), onClose: () => (closed += 1) }, { heartbeatMs: 80 });
  assert.equal(opened, 1);

  // A relay that answers each ping keeps its connection.
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(closed, 0, "a live relay is not dropped");

  goSilent();
  assert.ok(await until(() => closed === 1), "the gateway saw that the relay is gone");
  assert.ok(await until(() => opened === 2), "the gateway connected again");
});

test("a try that fails and a socket that closes later give one connection, and not two", async () => {
  // The opener stands for a relay that takes the connection and gives no
  // welcome. The try throws, and the socket of that try closes a moment later.
  let tries = 0;
  let open = 0;
  const closers = [];
  const opener = async (url, handlers) => {
    tries += 1;
    if (tries === 1) {
      setTimeout(() => handlers.onClose?.(), 30);
      throw new Error("the relay sent no welcome");
    }
    open += 1;
    const listeners = [];
    const link = {
      closed: false,
      connection: { on: (name, fn) => listeners.push(fn), send: () => true, drop: () => {} },
      close: () => {
        link.closed = true;
        open -= 1;
      },
    };
    closers.push(() => handlers.onClose?.());
    return link;
  };
  const errors = [];
  const second = await relaylink.keep("ws://127.0.0.1:1", { onError: (e) => errors.push(e.error) }, { heartbeatMs: 10_000, opener });
  try {
    assert.equal(errors.length, 1);
    await new Promise((r) => setTimeout(r, 2600));
    assert.equal(tries, 2, "one try after the failure, and not one for each event");
    assert.equal(open, 1);

    // The connection closes two times in a row, as a socket can. One new try follows.
    closers[0]();
    closers[0]();
    await new Promise((r) => setTimeout(r, 1300));
    assert.equal(tries, 3);
  } finally {
    second.stop();
  }
});
