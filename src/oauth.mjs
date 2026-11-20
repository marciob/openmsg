// OAuth 2.1 in front of the MCP server over HTTP, for a chat product that
// accepts no fixed token, such as the Gemini app on the web. The product
// registers itself (RFC 7591), sends the owner to a page of this server, and
// trades a code for a token, with PKCE (RFC 7636). Each address lives under
// the route of the server, so a proxy that gives only that route to the
// network gives all of it. Two discovery documents can also be asked for at
// the root, with the route after them (RFC 8414, RFC 9728).
//
// Only the owner approves a connection: the page asks for the secret of the
// token file of this agent. A person who has the address and not that secret
// gets no token.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const CODE_MS = 5 * 60_000;
const ACCESS_MS = 24 * 3_600_000;
const REFRESH_MS = 90 * 24 * 3_600_000;
const MAX_CLIENTS = 20;
const MAX_TRIES = 5;

const random = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
const hash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const sameText = (a, b) => {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function createOAuth({ name, ownerSecret, publicUrl, route, file, now = () => Date.now(), log = () => {} }) {
  const base = new URL(publicUrl);
  if (base.protocol !== "https:" && base.hostname !== "127.0.0.1" && base.hostname !== "localhost") {
    throw new Error("the public address of an OAuth server must start with https://");
  }
  const issuer = publicUrl.replace(/\/+$/, "");
  const at = (p) => `${issuer}${p}`;

  // The clients and the tokens survive a restart. A token is kept as its
  // digest, so the file gives no token that works.
  let store = { clients: {}, access: {}, refresh: {} };
  try {
    store = { ...store, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    // No file yet.
  }
  const save = () => {
    const t = now();
    for (const kind of ["access", "refresh"]) {
      for (const [k, v] of Object.entries(store[kind])) if (v.exp < t) delete store[kind][k];
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 1) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  const codes = new Map();
  let tries = [];

  const metadata = {
    issuer,
    authorization_endpoint: at("/oauth/authorize"),
    token_endpoint: at("/oauth/token"),
    registration_endpoint: at("/oauth/register"),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: ["openmsg"],
  };
  const resource = {
    resource: issuer,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openmsg"],
    resource_name: `openmsg mcp:${name}`,
  };
  const resourceMetadataUrl = at("/.well-known/oauth-protected-resource");

  // The paths of the discovery documents. A client asks for them at the
  // route, or at the root with the route after them.
  const wellKnown = {
    [`${route}/.well-known/oauth-protected-resource`]: resource,
    [`/.well-known/oauth-protected-resource${route}`]: resource,
    [`${route}/.well-known/oauth-authorization-server`]: metadata,
    [`/.well-known/oauth-authorization-server${route}`]: metadata,
    [`${route}/.well-known/openid-configuration`]: metadata,
    [`/.well-known/openid-configuration${route}`]: metadata,
  };

  function validToken(header) {
    const m = /^Bearer\s+(\S+)$/i.exec(String(header ?? ""));
    if (!m) return false;
    const row = store.access[hash(m[1])];
    return Boolean(row && row.exp > now() && store.clients[row.client]);
  }

  function handles(pathname) {
    return pathname in wellKnown || pathname.startsWith(`${route}/oauth/`);
  }

  // `send(code, body, headers)` writes JSON. `html(code, text)` writes a page.
  async function handle(req, pathname, body, { send, html, redirect, pause }) {
    if (pathname in wellKnown) {
      if (req.method !== "GET") return send(405, null, { allow: "GET" });
      return send(200, wellKnown[pathname], { "access-control-allow-origin": "*" });
    }
    const op = pathname.slice(`${route}/oauth/`.length);
    if (op === "register") return register(req, body, send);
    if (op === "authorize") return authorize(req, body, { send, html, redirect, pause });
    if (op === "token") return token(req, body, { send, pause });
    return send(404);
  }

  function register(req, body, send) {
    if (req.method !== "POST") return send(405, null, { allow: "POST" });
    let meta;
    try {
      meta = JSON.parse(body || "{}");
    } catch {
      return send(400, { error: "invalid_client_metadata", error_description: "the body is not JSON" });
    }
    const uris = Array.isArray(meta.redirect_uris) ? meta.redirect_uris : [];
    const fit = (u) => {
      try {
        const url = new URL(u);
        return url.protocol === "https:" || url.hostname === "127.0.0.1" || url.hostname === "localhost";
      } catch {
        return false;
      }
    };
    if (uris.length === 0 || !uris.every((u) => typeof u === "string" && fit(u))) {
      return send(400, { error: "invalid_redirect_uri", error_description: "give one or more https redirect_uris" });
    }
    if (Object.keys(store.clients).length >= MAX_CLIENTS) {
      return send(400, { error: "invalid_client_metadata", error_description: "this server holds the most clients that it takes" });
    }
    const method = ["client_secret_post", "client_secret_basic"].includes(meta.token_endpoint_auth_method) ? meta.token_endpoint_auth_method : "none";
    const id = `c_${random(12)}`;
    const secret = method === "none" ? null : random(32);
    store.clients[id] = {
      name: String(meta.client_name ?? "a client").slice(0, 80),
      redirectUris: uris,
      method,
      secret: secret ? hash(secret) : null,
      approved: false,
      at: new Date(now()).toISOString(),
    };
    save();
    log(`registered the client ${id} (${store.clients[id].name})`);
    return send(201, {
      client_id: id,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(now() / 1000),
      client_name: store.clients[id].name,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: method,
    });
  }

  function page(params, error = null) {
    const client = store.clients[params.client_id];
    const host = new URL(params.redirect_uri).host;
    const hidden = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope", "resource"]
      .map((k) => `<input type="hidden" name="${k}" value="${escape(params[k] ?? "")}">`)
      .join("");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>openmsg: approve a connection</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#222;background:#fafafa}
input[type=password]{width:100%;padding:.6rem;font-size:1rem;box-sizing:border-box}button{margin-top:1rem;padding:.6rem 1.2rem;font-size:1rem}
.err{color:#b00020}code{background:#eee;padding:0 .3rem}</style></head><body>
<h1>Approve a connection</h1>
<p><strong>${escape(client.name)}</strong> asks to act as <code>mcp:${escape(name)}</code> on this machine. After the approval, it reads the list of agents and writes to the addresses that this agent can reach.</p>
<p>It goes back to <code>${escape(host)}</code>.</p>
${error ? `<p class="err">${escape(error)}</p>` : ""}
<form method="post">${hidden}
<label for="s">The secret of this agent, from the token file of <code>mcp:${escape(name)}</code></label>
<input id="s" name="owner_secret" type="password" autocomplete="off" required autofocus>
<button type="submit">Approve</button></form></body></html>`;
  }

  async function authorize(req, body, { send, html, redirect, pause }) {
    const params = req.method === "POST"
      ? Object.fromEntries(new URLSearchParams(body))
      : Object.fromEntries(new URL(req.url, "http://local").searchParams);
    const client = store.clients[params.client_id];
    // With no known client or no known address, the page sends nobody back,
    // because the address could belong to an attacker.
    if (!client) return html(400, "<p>Unknown client. Register it first.</p>");
    if (!client.redirectUris.includes(params.redirect_uri)) return html(400, "<p>That redirect_uri is not registered for this client.</p>");
    const back = (query) => {
      const u = new URL(params.redirect_uri);
      for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
      if (params.state) u.searchParams.set("state", params.state);
      return redirect(u.toString());
    };
    if ((params.response_type ?? "code") !== "code" && req.method === "GET") return back({ error: "unsupported_response_type" });
    if (!params.code_challenge || params.code_challenge_method !== "S256") {
      return back({ error: "invalid_request", error_description: "PKCE with S256 is required" });
    }
    if (req.method === "GET") return html(200, page(params));
    if (req.method !== "POST") return send(405, null, { allow: "GET, POST" });

    const t = now();
    tries = tries.filter((x) => t - x < 60_000);
    if (tries.length >= MAX_TRIES) {
      await pause(1000);
      return html(429, page(params, "Too many tries. Wait one minute."));
    }
    if (!sameText(params.owner_secret ?? "", ownerSecret)) {
      tries.push(t);
      await pause(500);
      log(`refused an approval for ${params.client_id}: wrong secret`);
      return html(401, page(params, "That is not the secret. Try again."));
    }
    const code = random(32);
    codes.set(hash(code), { client: params.client_id, redirectUri: params.redirect_uri, challenge: params.code_challenge, exp: t + CODE_MS });
    client.approved = true;
    save();
    log(`the owner approved the client ${params.client_id} (${client.name})`);
    return back({ code });
  }

  function clientOf(req, params) {
    let id = params.client_id;
    let secret = params.client_secret;
    const basic = /^Basic\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""));
    if (basic) {
      const [u, p] = Buffer.from(basic[1], "base64").toString("utf8").split(":");
      id = decodeURIComponent(u ?? "");
      secret = decodeURIComponent(p ?? "");
    }
    const client = store.clients[id];
    if (!client) return null;
    if (client.secret && !(secret && sameText(hash(secret), client.secret))) return null;
    return { id, client };
  }

  function issue(clientId) {
    const access = random(32);
    const refresh = random(32);
    const t = now();
    store.access[hash(access)] = { client: clientId, exp: t + ACCESS_MS };
    store.refresh[hash(refresh)] = { client: clientId, exp: t + REFRESH_MS };
    save();
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_MS / 1000, refresh_token: refresh, scope: "openmsg" };
  }

  async function token(req, body, { send, pause }) {
    if (req.method !== "POST") return send(405, null, { allow: "POST" });
    const type = String(req.headers["content-type"] ?? "");
    let params = {};
    try {
      params = type.includes("application/json") ? JSON.parse(body || "{}") : Object.fromEntries(new URLSearchParams(body));
    } catch {
      return send(400, { error: "invalid_request" });
    }
    const cors = { "access-control-allow-origin": "*" };
    const who = clientOf(req, params);
    if (!who) {
      await pause(300);
      return send(401, { error: "invalid_client" }, cors);
    }
    if (params.grant_type === "authorization_code") {
      const key = hash(params.code ?? "");
      const row = codes.get(key);
      codes.delete(key);
      const verifier = String(params.code_verifier ?? "");
      const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
      if (!row || row.exp < now() || row.client !== who.id || row.redirectUri !== params.redirect_uri || !sameText(challenge, row.challenge)) {
        await pause(300);
        return send(400, { error: "invalid_grant" }, cors);
      }
      log(`gave a token to the client ${who.id}`);
      return send(200, issue(who.id), cors);
    }
    if (params.grant_type === "refresh_token") {
      const key = hash(params.refresh_token ?? "");
      const row = store.refresh[key];
      if (!row || row.exp < now() || row.client !== who.id) {
        await pause(300);
        return send(400, { error: "invalid_grant" }, cors);
      }
      // One refresh token works one time. The answer holds a new one.
      delete store.refresh[key];
      return send(200, issue(who.id), cors);
    }
    return send(400, { error: "unsupported_grant_type" }, cors);
  }

  function revokeAll() {
    store = { clients: {}, access: {}, refresh: {} };
    save();
  }

  function clients() {
    return Object.entries(store.clients).map(([id, c]) => ({ id, name: c.name, approved: c.approved, at: c.at }));
  }

  return { handles, handle, validToken, resourceMetadataUrl, revokeAll, clients, metadata };
}
