// Tests for OAuth in front of the MCP server over HTTP: discovery, the
// registration of a client, the approval of the owner, PKCE, the token, and
// the refresh. The server listens on the loopback address and stops at the
// end.
// Run: node --test
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-oauth-"));
process.env.OPENMSG_HOME = HOME;
const mcpagents = await import("../src/mcpagents.mjs");
const mcp = await import("../src/mcp.mjs");
const { createOAuth } = await import("../src/oauth.mjs");

mcpagents.add("gemini", { allow: ["mcp:helper"] });
mcpagents.add("helper", { allow: ["mcp:gemini"] });

const SECRET = mcp.newToken();
const ROUTE = "/r4nd0m-route";
const PUBLIC = `https://example.test${ROUTE}`;
const oauth = createOAuth({ name: "gemini", ownerSecret: SECRET, publicUrl: PUBLIC, route: ROUTE, file: path.join(HOME, "mcp-gemini.oauth.json") });
const running = await mcp.serveHttp({ name: "gemini", token: SECRET, route: ROUTE, oauth });
after(() => running.close());
const origin = `http://127.0.0.1:${running.port}`;
const REDIRECT = "https://chat.example/callback";

const verifier = crypto.randomBytes(32).toString("base64url");
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
const callMcp = (token) =>
  fetch(origin + ROUTE, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(init) });
const form = (o) => new URLSearchParams(o).toString();

let client;
let tokens;

test("a request with no token gets 401, and the header names the discovery document", async () => {
  const res = await callMcp(null);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("www-authenticate"), `Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource"`);
});

test("the discovery documents answer at the route and at the root", async () => {
  const pr = await (await fetch(`${origin}/.well-known/oauth-protected-resource${ROUTE}`)).json();
  assert.deepEqual(pr.authorization_servers, [PUBLIC]);
  for (const p of [`${ROUTE}/.well-known/oauth-authorization-server`, `/.well-known/oauth-authorization-server${ROUTE}`, `${ROUTE}/.well-known/openid-configuration`]) {
    const md = await (await fetch(origin + p)).json();
    assert.equal(md.registration_endpoint, `${PUBLIC}/oauth/register`);
    assert.deepEqual(md.code_challenge_methods_supported, ["S256"]);
  }
});

test("a client registers itself, and a redirect address that is not https fails", async () => {
  const bad = await fetch(`${origin}${ROUTE}/oauth/register`, { method: "POST", body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }) });
  assert.equal(bad.status, 400);
  const res = await fetch(`${origin}${ROUTE}/oauth/register`, { method: "POST", body: JSON.stringify({ client_name: "Gemini", redirect_uris: [REDIRECT] }) });
  assert.equal(res.status, 201);
  client = await res.json();
  assert.match(client.client_id, /^c_/);
  assert.equal(client.token_endpoint_auth_method, "none");
});

test("the approval page names the client, and it sends nobody to an address that is not registered", async () => {
  const q = { response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s1" };
  const page = await fetch(`${origin}${ROUTE}/oauth/authorize?${form(q)}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.match(await page.text(), /<strong>Gemini<\/strong>/);
  const other = await fetch(`${origin}${ROUTE}/oauth/authorize?${form({ ...q, redirect_uri: "https://evil.example/cb" })}`, { redirect: "manual" });
  assert.equal(other.status, 400);
  const plain = await fetch(`${origin}${ROUTE}/oauth/authorize?${form({ ...q, code_challenge_method: "plain" })}`, { redirect: "manual" });
  assert.equal(plain.status, 302);
  assert.match(plain.headers.get("location"), /error=invalid_request/);
});

test("a wrong secret gives no code, the secret of the owner gives one, and the code works one time with its verifier", async () => {
  const q = { client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s2" };
  const post = (secret) => fetch(`${origin}${ROUTE}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ ...q, owner_secret: secret }) });
  const wrong = await post("not the secret");
  assert.equal(wrong.status, 401);
  const ok = await post(SECRET);
  assert.equal(ok.status, 302);
  const back = new URL(ok.headers.get("location"));
  assert.equal(back.origin + back.pathname, REDIRECT);
  assert.equal(back.searchParams.get("state"), "s2");
  const code = back.searchParams.get("code");

  const trade = (v) => fetch(`${origin}${ROUTE}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: v }) });
  const bad = await trade("a wrong verifier");
  assert.equal(bad.status, 400);
  // The failed try used the code, so the right verifier fails after it too.
  assert.equal((await trade(verifier)).status, 400);

  const again = new URL((await post(SECRET)).headers.get("location")).searchParams.get("code");
  const res = await fetch(`${origin}${ROUTE}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ grant_type: "authorization_code", code: again, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier }) });
  assert.equal(res.status, 200);
  tokens = await res.json();
  assert.equal(tokens.token_type, "Bearer");
  assert.ok(tokens.access_token && tokens.refresh_token);
});

test("the token opens the MCP server, and the fixed token still works", async () => {
  const res = await callMcp(tokens.access_token);
  assert.equal(res.status, 200);
  assert.match((await res.json()).result.instructions, /mcp:gemini/);
  assert.equal((await callMcp(SECRET)).status, 200);
  assert.equal((await callMcp("made-up-token")).status, 401);
});

test("a refresh token gives a new pair one time, and the file holds no token that works", async () => {
  const refresh = () => fetch(`${origin}${ROUTE}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id }) });
  const first = await refresh();
  assert.equal(first.status, 200);
  const next = await first.json();
  assert.equal((await refresh()).status, 400);
  assert.equal((await callMcp(next.access_token)).status, 200);
  const file = fs.readFileSync(path.join(HOME, "mcp-gemini.oauth.json"), "utf8");
  assert.ok(!file.includes(next.access_token) && !file.includes(next.refresh_token) && !file.includes(SECRET));
});
