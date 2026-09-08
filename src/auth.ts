// A complete OAuth 2.1 authorization server with exactly one user: you.
// The MCP SDK provides discovery, dynamic client registration, PKCE checks
// and the token endpoint; this file supplies the storage behind them and a
// password login page. Tokens are stored hashed.
//
// Pending logins, authorization codes, and registered OAuth clients are
// HMAC-signed blobs so authorize, /login, token exchange, and cached
// client_id lookups work across multiple instances (e.g. Manufact) without
// shared memory or durable /data — signed client attestation survives
// ephemeral host redeploys that wipe oauth.clients.
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, InvalidClientError, InvalidClientMetadataError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { config } from "./config.ts";
import { loginPage } from "./pages.ts";
export { loginPage, shell as page } from "./pages.ts";
import type { Store, OAuthClient, Token } from "./store.ts";

const ACCESS_TTL = 60 * 60; // 1 hour
const REFRESH_TTL = 90 * 24 * 60 * 60; // 90 days
const CODE_TTL = 10 * 60;
const LOGIN_TTL = 30 * 60;
const CLIENT_TTL = 10 * 365 * 24 * 60 * 60; // 10y — public clients only

// --- Password ---

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string): boolean {
  if (config.adminPasswordHash) {
    const [scheme, salt, expected] = config.adminPasswordHash.split("$");
    if (scheme !== "scrypt" || !salt || !expected) return false;
    const actual = scryptSync(password, Buffer.from(salt, "base64"), 64);
    const exp = Buffer.from(expected, "base64");
    return actual.length === exp.length && timingSafeEqual(actual, exp);
  }
  if (config.adminPassword) {
    const a = Buffer.from(password);
    const b = Buffer.from(config.adminPassword);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  return false;
}

export function redirectAllowed(uri: string): boolean {
  try {
    const host = new URL(uri).hostname.toLowerCase();
    return config.allowedRedirectHosts.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);

/** Stable across instances that share the same env secrets. */
function signingKey(): Buffer {
  const raw = config.adminPasswordHash || config.adminPassword || config.privateKey || "bankmcp-dev";
  return createHash("sha256").update(raw).digest();
}

function signBlob(payload: object): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", signingKey()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyBlob<T extends { expires: number }>(blob: string): T | null {
  const dot = blob.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = blob.slice(0, dot);
  const sig = blob.slice(dot + 1);
  const expected = createHmac("sha256", signingKey()).update(body).digest("base64url");
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
    if (!parsed || typeof parsed.expires !== "number" || parsed.expires < now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

interface LoginBlob {
  typ: "login";
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource?: string;
  scopes: string[];
  state?: string;
  expires: number;
  attempts: number;
}

interface CodeBlob {
  typ: "code";
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource?: string;
  scopes: string[];
  expires: number;
}

interface ClientBlob {
  typ: "client";
  redirect_uris: string[];
  client_name?: string;
  token_endpoint_auth_method?: string;
  grant_types?: string[];
  response_types?: string[];
  scope?: string;
  /** long-lived; e.g. 10y — public clients only */
  expires: number;
}

function clientFromAttestation(clientId: string): OAuthClientInformationFull | undefined {
  const b = verifyBlob<ClientBlob>(clientId);
  if (!b || b.typ !== "client" || !Array.isArray(b.redirect_uris) || !b.redirect_uris.length) return undefined;
  for (const uri of b.redirect_uris) {
    if (!redirectAllowed(uri)) return undefined;
  }
  return {
    client_id: clientId,
    redirect_uris: b.redirect_uris,
    client_name: b.client_name,
    token_endpoint_auth_method: b.token_endpoint_auth_method ?? "none",
    grant_types: b.grant_types ?? ["authorization_code", "refresh_token"],
    response_types: b.response_types ?? ["code"],
    scope: b.scope,
  } as OAuthClientInformationFull;
}

export interface LoginEvent {
  ok: boolean;
  ip: string;
  clientName?: string;
  reason?: string;
}

export class SingleUserProvider implements OAuthServerProvider {
  private failures = new Map<string, { count: number; until: number }>();
  private store: Store;
  private onLogin?: (e: LoginEvent) => void;

  constructor(store: Store, opts: { onLogin?: (e: LoginEvent) => void } = {}) {
    this.store = store;
    this.onLogin = opts.onLogin;
  }

  /** Every token and pending code is dropped. Used when the admin password changes. */
  revokeAll(): void {
    this.store.update((d) => {
      d.oauth.tokens = {};
      d.oauth.codes = {};
    });
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    const store = this.store;
    return {
      getClient(clientId) {
        const local = store.data.oauth.clients[clientId] as OAuthClientInformationFull | undefined;
        if (local) return local;
        const attested = clientFromAttestation(clientId);
        if (!attested) return undefined;
        // best-effort rehydrate (ignore write failures on read-only/ephemeral FS)
        try {
          store.update((d) => { d.oauth.clients[clientId] = attested as OAuthClient; });
        } catch { /* ignore */ }
        return attested;
      },
      registerClient(client) {
        for (const uri of client.redirect_uris) {
          if (!redirectAllowed(uri)) {
            throw new InvalidClientMetadataError(
              `redirect_uri host not allowed: ${new URL(uri).hostname}. Set ALLOWED_REDIRECT_HOSTS on the server to permit it.`
            );
          }
        }
        // Reject confidential DCR unless you also store secrets out-of-band
        const method = client.token_endpoint_auth_method ?? "none";
        if (method !== "none") {
          throw new InvalidClientMetadataError("Only token_endpoint_auth_method=none is supported for attested clients");
        }

        const blob: ClientBlob = {
          typ: "client",
          redirect_uris: client.redirect_uris,
          client_name: client.client_name,
          token_endpoint_auth_method: "none",
          grant_types: client.grant_types,
          response_types: client.response_types,
          scope: client.scope,
          expires: now() + CLIENT_TTL,
        };
        const client_id = signBlob(blob); // <-- THIS is what Cursor caches
        const full: OAuthClient = {
          ...(client as OAuthClient),
          client_id,
          client_id_issued_at: now(),
          token_endpoint_auth_method: "none",
        };
        try {
          store.update((d) => {
            const ids = Object.keys(d.oauth.clients);
            if (ids.length > 20) for (const id of ids.slice(0, ids.length - 20)) delete d.oauth.clients[id];
            d.oauth.clients[full.client_id] = full;
          });
        } catch {
          // registration must succeed even if /data is gone after process start
        }
        return full as OAuthClientInformationFull;
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const blob: LoginBlob = {
      typ: "login",
      client_id: client.client_id,
      redirect_uri: params.redirectUri,
      code_challenge: params.codeChallenge,
      resource: params.resource?.href,
      scopes: params.scopes ?? [],
      state: params.state,
      expires: now() + LOGIN_TTL,
      attempts: 0,
    };
    res.status(200).type("html").send(loginPage({ requestId: signBlob(blob), clientName: client.client_name, returnTo: new URL(params.redirectUri).hostname }));
  }

  /** Called by POST /login. Returns the redirect URL on success, or an error message. */
  completeLogin(requestId: string, password: string, ip: string): { redirect: string } | { error: string; requestId?: string } {
    this.sweepFailures();
    const lock = this.failures.get(ip);
    if (lock && lock.until > now()) {
      this.onLogin?.({ ok: false, ip, reason: "locked out" });
      return { error: "Too many attempts. Try again in a few minutes." };
    }

    const pending = verifyBlob<LoginBlob>(requestId);
    if (!pending || pending.typ !== "login") {
      return { error: "This sign-in page has expired or the server restarted. Go back to your assistant, click Connect again, and enter the password within 30 minutes." };
    }

    const client = this.clientsStore.getClient(pending.client_id);
    if (!client) {
      return { error: "This sign-in page has expired or the server restarted. Go back to your assistant, click Connect again, and enter the password within 30 minutes." };
    }

    if (!verifyPassword(password)) {
      pending.attempts += 1;
      const f = this.failures.get(ip) ?? { count: 0, until: 0 };
      f.count += 1;
      if (f.count >= 5) f.until = now() + 15 * 60;
      this.failures.set(ip, f);
      this.onLogin?.({ ok: false, ip, clientName: client.client_name, reason: "wrong password" });
      if (pending.attempts >= 5) return { error: "Wrong password." };
      return { error: "Wrong password.", requestId: signBlob(pending) };
    }

    this.failures.delete(ip);
    this.onLogin?.({ ok: true, ip, clientName: client.client_name });
    const codeBlob: CodeBlob = {
      typ: "code",
      client_id: pending.client_id,
      redirect_uri: pending.redirect_uri,
      code_challenge: pending.code_challenge,
      resource: pending.resource,
      scopes: pending.scopes,
      expires: now() + CODE_TTL,
    };
    const code = signBlob(codeBlob);
    // Optional local record for hygiene; verification does not require it.
    this.store.update((d) => {
      for (const [c, v] of Object.entries(d.oauth.codes)) if (v.expires < now()) delete d.oauth.codes[c];
      d.oauth.codes[sha256(code)] = {
        client_id: pending.client_id,
        code_challenge: pending.code_challenge,
        redirect_uri: pending.redirect_uri,
        resource: pending.resource,
        scopes: pending.scopes,
        expires: now() + CODE_TTL,
      };
    });
    const url = new URL(pending.redirect_uri);
    url.searchParams.set("code", code);
    if (pending.state) url.searchParams.set("state", pending.state);
    return { redirect: url.href };
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const c = verifyBlob<CodeBlob>(authorizationCode);
    if (!c || c.typ !== "code" || c.client_id !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
    return c.code_challenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string, _codeVerifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const c = verifyBlob<CodeBlob>(authorizationCode);
    if (!c || c.typ !== "code" || c.client_id !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
    if (redirectUri && redirectUri !== c.redirect_uri) throw new InvalidGrantError("redirect_uri does not match");
    if (resource && c.resource && resource.href !== c.resource) throw new InvalidGrantError("resource does not match");
    return this.store.update((d) => {
      delete d.oauth.codes[sha256(authorizationCode)];
      return this.issue(d.oauth.tokens, client.client_id, c.scopes, c.resource);
    });
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const key = sha256(refreshToken);
    const t = this.store.data.oauth.tokens[key];
    if (!t || t.kind !== "refresh" || t.client_id !== client.client_id) throw new InvalidGrantError("Invalid refresh token");
    if (t.expires < now()) throw new InvalidGrantError("Refresh token expired");
    if (resource && t.resource && resource.href !== t.resource) throw new InvalidGrantError("resource does not match");
    return this.store.update((d) => {
      delete d.oauth.tokens[key];
      return this.issue(d.oauth.tokens, client.client_id, scopes?.length ? scopes : t.scopes, t.resource);
    });
  }

  async verifyAccessToken(tokenValue: string): Promise<AuthInfo> {
    const t = this.store.data.oauth.tokens[sha256(tokenValue)];
    if (!t || t.kind !== "access") throw new InvalidClientError("Invalid access token");
    if (t.expires < now()) throw new InvalidClientError("Access token expired");
    return { token: tokenValue, clientId: t.client_id, scopes: t.scopes, expiresAt: t.expires, resource: t.resource ? new URL(t.resource) : undefined };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const key = sha256(request.token);
    const t = this.store.data.oauth.tokens[key];
    if (t && t.client_id === client.client_id) this.store.update((d) => void delete d.oauth.tokens[key]);
  }

  private issue(tokens: Record<string, Token>, clientId: string, scopes: string[], resource?: string): OAuthTokens {
    for (const [k, v] of Object.entries(tokens)) if (v.expires < now()) delete tokens[k];
    const access = token();
    const refresh = token();
    tokens[sha256(access)] = { kind: "access", client_id: clientId, scopes, resource, expires: now() + ACCESS_TTL };
    tokens[sha256(refresh)] = { kind: "refresh", client_id: clientId, scopes, resource, expires: now() + REFRESH_TTL };
    return { access_token: access, token_type: "bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope: scopes.join(" ") || undefined };
  }

  private sweepFailures() {
    const t = now();
    for (const [k, v] of this.failures) if (v.until && v.until < t) this.failures.delete(k);
  }
}
