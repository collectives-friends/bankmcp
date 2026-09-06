// HTTP entry point: the MCP endpoint behind OAuth, the OAuth server itself,
// the Enable Banking redirect target, and a status page.
import { createHash } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import express from "express";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config, isConfigured, setupProblems, tlsOptions } from "./config.ts";
import { eb, EnableBankingError } from "./enablebanking.ts";
import { store } from "./store.ts";
import { SingleUserProvider } from "./auth.ts";
import { connectedPage, failedPage, loginPage, privacyPage, shell as page, statusPage, termsPage } from "./pages.ts";
import { createServer, VERSION } from "./mcp.ts";
import { startWatcher } from "./watcher.ts";

const log = (msg: string, extra?: unknown) => console.log(`[bank ${new Date().toISOString()}] ${msg}`, extra ?? "");

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

const baseUrl = new URL(config.baseUrl);
const mcpUrl = new URL("/mcp", baseUrl);
const provider = new SingleUserProvider(store(), {
  onLogin: (e) => {
    const who = e.clientName ? ` for ${e.clientName}` : "";
    if (e.ok) {
      log(`sign-in from ${e.ip}${who}`);
      notify(`${config.appName}: new sign-in from ${e.ip}${who}. If this was not you, change ADMIN_PASSWORD now; that logs every client out.`);
    } else {
      log(`failed sign-in from ${e.ip}${who} (${e.reason})`);
    }
  },
});

// Changing the admin password logs every client out.
{
  const fingerprint = createHash("sha256").update(config.adminPasswordHash || config.adminPassword).digest("hex");
  if (store().data.oauth.password_fingerprint && store().data.oauth.password_fingerprint !== fingerprint) {
    provider.revokeAll();
    log("admin password changed: all tokens revoked");
  }
  if (store().data.oauth.password_fingerprint !== fingerprint) store().update((d) => void (d.oauth.password_fingerprint = fingerprint));
}

function notify(text: string): void {
  if (!config.notifyWebhookUrl) return;
  const slack = /hooks\.slack\.com/.test(config.notifyWebhookUrl);
  fetch(config.notifyWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(slack ? { text } : { source: config.appName, type: "sign_in", text }),
  }).catch((err) => log("notify failed", (err as Error).message));
}

// --- Status page, health, legal ---

app.get("/", (_req, res) => {
  res.type("html").send(statusPage({ problems: setupProblems(), mcpUrl: mcpUrl.href }));
});

app.get("/healthz", (_req, res) => void res.json({ ok: true, version: VERSION, configured: isConfigured() }));

app.get("/privacy", (_req, res) => void res.type("html").send(privacyPage()));
app.get("/terms", (_req, res) => void res.type("html").send(termsPage()));

// --- OAuth server for the MCP connector (single user) ---

app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: baseUrl,
    resourceServerUrl: mcpUrl,
    resourceName: "bank-mcp",
    scopesSupported: ["bank:read"],
    clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
  }),
);

app.post("/login", express.urlencoded({ extended: false }), (req, res) => {
  const { request, password } = req.body as Record<string, string | undefined>;
  const result = provider.completeLogin(String(request ?? ""), String(password ?? ""), req.ip ?? "unknown");
  if ("redirect" in result) return void res.redirect(302, result.redirect);
  if (result.requestId) return void res.status(401).type("html").send(loginPage({ requestId: result.requestId, error: result.error }));
  res.status(400).type("html").send(failedPage(result.error));
});

// --- MCP endpoint (stateless: one transport per request) ---

const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });

app.post("/mcp", bearer, express.json({ limit: "1mb" }), async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    log("mcp request failed", err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});

app.get("/mcp", bearer, (_req, res) => void res.status(405).set("Allow", "POST").json({ error: "This server is stateless; use POST." }));
app.delete("/mcp", bearer, (_req, res) => void res.status(405).set("Allow", "POST").json({ error: "This server is stateless; use POST." }));

// --- Enable Banking redirect target ---

app.get("/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query as Record<string, string | undefined>;
  const pending = state ? store().takePendingAuth(state) : undefined;
  const failed = (msg: string) => res.status(400).type("html").send(failedPage(msg));

  if (error || !code) return void failed(error_description || error || "The bank did not return an authorization code.");
  if (!pending) return void failed("Unknown or expired authorization. Start again from Claude.");

  try {
    const session = await eb.createSession(code);
    store().addSession(session);
    log(`bank connected: ${session.aspsp.name}, ${session.accounts.length} account(s)`);
    res.type("html").send(connectedPage(session));
  } catch (err) {
    const msg = err instanceof EnableBankingError ? `Enable Banking returned ${err.status}: ${err.body.slice(0, 300)}` : (err as Error).message;
    log("callback failed", msg);
    failed(msg);
  }
});

// --- Start ---

const tls = tlsOptions();
const httpServer = tls ? createHttpsServer(tls, app) : createHttpServer(app);
httpServer.listen(config.port, () => {
  log(`listening on ${tls ? "https" : "http"}://0.0.0.0:${config.port}, public URL ${config.baseUrl}`);
  const problems = setupProblems();
  if (problems.length) log("not configured:", problems);
  else startWatcher();
});
