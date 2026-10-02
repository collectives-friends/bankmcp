import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ADMIN_PASSWORD = "correct horse";
process.env.BASE_URL = "http://localhost:8080";
const { SingleUserProvider, hashPassword, verifyPassword } = await import("../src/auth.ts");
const { Store } = await import("../src/store.ts");

const fakeRes = () => {
  const out = { status: 0, body: "" };
  const res = { status: (s: number) => ((out.status = s), res), type: () => res, send: (b: string) => ((out.body = b), res) };
  return { out, res: res as unknown as import("express").Response };
};

test("password hashing round-trips and the hash takes precedence over a plain password", () => {
  const h = hashPassword("secret-123");
  assert.match(h, /^scrypt\$/);
  process.env.ADMIN_PASSWORD_HASH = h;
  try {
    assert.equal(verifyPassword("secret-123"), true);
    assert.equal(verifyPassword("correct horse"), false, "plain ADMIN_PASSWORD is ignored while a hash is set");
  } finally {
    delete process.env.ADMIN_PASSWORD_HASH;
  }
  assert.equal(verifyPassword("correct horse"), true);
});

test("full authorization code flow with PKCE, refresh and revocation", async () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "bank-")), "store.json"));
  const provider = new SingleUserProvider(store);
  const client = await provider.clientsStore.registerClient!({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "Claude", token_endpoint_auth_method: "none" });
  assert.ok(client.client_id);
  assert.equal(client.client_secret, undefined, "public client gets no secret");

  const { out, res } = fakeRes();
  await provider.authorize(client, { codeChallenge: "challenge", redirectUri: client.redirect_uris[0]!, state: "xyz", scopes: ["bank:read"] }, res);
  assert.equal(out.status, 200);
  const requestId = /name="request" value="([^"]+)"/.exec(out.body)?.[1];
  assert.ok(requestId, "login page carries the request id");

  const wrong = provider.completeLogin(requestId!, "nope", "1.2.3.4");
  assert.ok("error" in wrong && typeof wrong.requestId === "string", "wrong password re-offers the (re-signed) request");

  const ok = provider.completeLogin(requestId!, "correct horse", "1.2.3.4");
  assert.ok("redirect" in ok);
  const url = new URL(ok.redirect);
  assert.equal(url.origin + url.pathname, client.redirect_uris[0]);
  assert.equal(url.searchParams.get("state"), "xyz");
  const code = url.searchParams.get("code")!;

  // Signed login requests (multi-instance fork) are not single use; the admin password gates every new code.

  assert.equal(await provider.challengeForAuthorizationCode(client, code), "challenge");
  const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, client.redirect_uris[0]);
  assert.ok(tokens.access_token && tokens.refresh_token);
  // Replay is covered below: it is invalid_grant and revokes this pair (PORT-003).

  const info = await provider.verifyAccessToken(tokens.access_token);
  assert.equal(info.clientId, client.client_id);
  assert.deepEqual(info.scopes, ["bank:read"]);
  assert.ok(!JSON.stringify(store.data).includes(tokens.access_token), "tokens are stored hashed");

  const refreshed = await provider.exchangeRefreshToken(client, tokens.refresh_token!);
  assert.notEqual(refreshed.access_token, tokens.access_token);
  await assert.rejects(provider.exchangeRefreshToken(client, tokens.refresh_token!), /Invalid/, "refresh tokens rotate");

  await provider.revokeToken!(client, { token: refreshed.access_token });
  await assert.rejects(provider.verifyAccessToken(refreshed.access_token), /Invalid/);
});

test("five wrong passwords lock the address out", async () => {
  const provider = new SingleUserProvider(new Store(join(mkdtempSync(join(tmpdir(), "bank-")), "store.json")));
  const client = await provider.clientsStore.registerClient!({ redirect_uris: ["https://claude.ai/cb"] });
  for (let i = 0; i < 5; i++) {
    const { out, res } = fakeRes();
    await provider.authorize(client, { codeChallenge: "c", redirectUri: "https://claude.ai/cb" }, res);
    const id = /name="request" value="([^"]+)"/.exec(out.body)![1]!;
    provider.completeLogin(id, "wrong", "9.9.9.9");
  }
  const { out, res } = fakeRes();
  await provider.authorize(client, { codeChallenge: "c", redirectUri: "https://claude.ai/cb" }, res);
  const id = /name="request" value="([^"]+)"/.exec(out.body)![1]!;
  const r = provider.completeLogin(id, "correct horse", "9.9.9.9");
  assert.ok("error" in r && /Too many/.test(r.error));
});

test("revokeAll drops every token", async () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "bank-")), "store.json"));
  const events: unknown[] = [];
  const provider = new SingleUserProvider(store, { onLogin: (e) => events.push(e) });
  const client = await provider.clientsStore.registerClient!({ redirect_uris: ["https://claude.ai/cb"], client_name: "Claude" });
  const { out, res } = fakeRes();
  await provider.authorize(client, { codeChallenge: "c", redirectUri: "https://claude.ai/cb" }, res);
  const id = /name="request" value="([^"]+)"/.exec(out.body)![1]!;
  const ok = provider.completeLogin(id, "correct horse", "5.5.5.5");
  assert.ok("redirect" in ok);
  assert.deepEqual(events, [{ ok: true, ip: "5.5.5.5", clientName: "Claude" }]);
  const tokens = await provider.exchangeAuthorizationCode(client, new URL(ok.redirect).searchParams.get("code")!, undefined, "https://claude.ai/cb");
  await provider.verifyAccessToken(tokens.access_token);
  provider.revokeAll();
  await assert.rejects(provider.verifyAccessToken(tokens.access_token), /Invalid/);
  await assert.rejects(provider.exchangeRefreshToken(client, tokens.refresh_token!), /Invalid/);
});

test("clients may only redirect to allowed hosts", async () => {
  const provider = new SingleUserProvider(new Store(join(mkdtempSync(join(tmpdir(), "bank-")), "store.json")));
  await assert.rejects(async () => provider.clientsStore.registerClient!({ redirect_uris: ["https://evil.example/cb"] }), /not allowed/);
  await provider.clientsStore.registerClient!({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback", "http://localhost:53421/callback"] });
  await assert.rejects(async () => provider.clientsStore.registerClient!({ redirect_uris: ["https://claude.ai.evil.example/cb"] }), /not allowed/);
});

test("well-known MCP client domains are allowed by default", async () => {
  const { redirectAllowed } = await import("../src/auth.ts");
  for (const u of ["https://claude.ai/api/mcp/auth_callback", "https://chatgpt.com/connector_platform_oauth_redirect", "https://chat.mistral.ai/oauth/callback", "https://cursor.com/oauth/callback", "http://localhost:3456/cb"]) assert.equal(redirectAllowed(u), true, u);
  for (const u of ["https://evil.example/cb", "https://chatgpt.com.evil.example/cb", "https://notclaude.ai/cb"]) assert.equal(redirectAllowed(u), false, u);
});

// PORT-003: an authorization code is single use (RFC 6749 §4.1.2).
async function signedInCode(provider: InstanceType<typeof SingleUserProvider>, redirectUri: string, codeChallenge = "challenge") {
  const client = await provider.clientsStore.registerClient!({ redirect_uris: [redirectUri], client_name: "Test", token_endpoint_auth_method: "none" });
  const { out, res } = fakeRes();
  await provider.authorize(client, { codeChallenge, redirectUri, scopes: ["bank:read"] }, res);
  const ok = provider.completeLogin(/name="request" value="([^"]+)"/.exec(out.body)![1]!, "correct horse", "7.7.7.7");
  assert.ok("redirect" in ok);
  return { client, code: new URL(ok.redirect).searchParams.get("code")! };
}

const tokenCount = (store: InstanceType<typeof Store>) => Object.keys(store.data.oauth.tokens).length;

test("a redeemed authorization code is invalid_grant on replay, mints nothing and revokes the first pair", async () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "bank-")), "store.json"));
  const provider = new SingleUserProvider(store);
  const { client, code } = await signedInCode(provider, "https://claude.ai/cb");
  const first = await provider.exchangeAuthorizationCode(client, code, undefined, "https://claude.ai/cb");
  assert.equal(tokenCount(store), 2);
  await assert.rejects(provider.exchangeAuthorizationCode(client, code, undefined, "https://claude.ai/cb"), (e: Error) => e.name === "InvalidGrantError" || (e as { errorCode?: string }).errorCode === "invalid_grant");
  assert.equal(tokenCount(store), 0, "replay mints no new pair and revokes the pair issued from the code");
  await assert.rejects(provider.verifyAccessToken(first.access_token), /Invalid/);
  await assert.rejects(provider.exchangeRefreshToken(client, first.refresh_token!), /Invalid/);
  const persisted = new Store(store.path);
  assert.equal(Object.keys(persisted.data.oauth.tokens).length, 0, "revocation is persisted");
});

test("an expired authorization code is rejected", async (t) => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "bank-")), "store.json"));
  const provider = new SingleUserProvider(store);
  const { client, code } = await signedInCode(provider, "https://claude.ai/cb");
  const later = Date.now() + 11 * 60 * 1000;
  t.mock.method(Date, "now", () => later);
  await assert.rejects(provider.exchangeAuthorizationCode(client, code, undefined, "https://claude.ai/cb"), /Invalid or expired/);
  assert.equal(tokenCount(store), 0);
});

test("token endpoint: client, redirect_uri and PKCE stay bound; parallel redemptions yield at most one pair", async () => {
  const { createHash } = await import("node:crypto");
  const express = (await import("express")).default;
  const { mcpAuthRouter } = await import("@modelcontextprotocol/sdk/server/auth/router.js");
  const store = new Store(join(mkdtempSync(join(tmpdir(), "bank-")), "store.json"));
  const provider = new SingleUserProvider(store);
  const app = express();
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://localhost:${(server.address() as import("node:net").AddressInfo).port}`;
  app.use(mcpAuthRouter({ provider, issuerUrl: new URL(base), resourceServerUrl: new URL("/mcp", base), scopesSupported: ["bank:read"] }));
  try {
    const verifier = "v".repeat(64);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const redirect = "http://localhost:8765/callback";
    const { client, code } = await signedInCode(provider, redirect, challenge);
    const other = await provider.clientsStore.registerClient!({ redirect_uris: [redirect], token_endpoint_auth_method: "none" });
    const redeem = (over: Record<string, string> = {}) =>
      fetch(`${base}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, code, redirect_uri: redirect, code_verifier: verifier, ...over }),
      }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, string> }));

    for (const bad of [{ client_id: other.client_id }, { redirect_uri: "http://localhost:9999/callback" }, { code_verifier: "w".repeat(64) }]) {
      const r = await redeem(bad);
      assert.equal(r.body.error, "invalid_grant", JSON.stringify(Object.keys(bad)));
    }
    assert.equal(tokenCount(store), 0);

    const results = await Promise.all([redeem(), redeem(), redeem()]);
    const issued = results.filter((r) => r.status === 200);
    assert.ok(issued.length <= 1, `at most one pair, got ${issued.length}`);
    for (const r of results.filter((r) => r.status !== 200)) assert.equal(r.body.error, "invalid_grant");
    assert.ok(tokenCount(store) <= 2, "store holds at most one pair");
    assert.equal((await redeem()).body.error, "invalid_grant");
  } finally {
    server.close();
  }
});
