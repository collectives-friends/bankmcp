// HTTP entry point: the MCP endpoint behind OAuth, the OAuth server itself,
// the Enable Banking redirect target, and a status page.
import { createServer as createHttpsServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import express from "express";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config, isConfigured, setupProblems, tlsOptions } from "./config.ts";
import { eb, EnableBankingError } from "./enablebanking.ts";
import { store } from "./store.ts";
import { SingleUserProvider, loginPage, page } from "./auth.ts";
import { createServer, VERSION } from "./mcp.ts";
import { startWatcher } from "./watcher.ts";
import { daysLeft } from "./data.ts";

const log = (msg: string, extra?: unknown) => console.log(`[openbanking ${new Date().toISOString()}] ${msg}`, extra ?? "");
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

const baseUrl = new URL(config.baseUrl);
const mcpUrl = new URL("/mcp", baseUrl);
const provider = new SingleUserProvider(store());

// --- Status page, health, legal ---

app.get("/", (_req, res) => {
  const problems = setupProblems();
  const s = store();
  const banks = s.sessions().map((x) => `<li>${esc(x.bank.name)} · ${s.accounts().filter((a) => a.session_id === x.id).length} account(s) · consent ${daysLeft(x.valid_until)} days left</li>`);
  res.type("html").send(
    page(
      config.appName,
      problems.length
        ? `<p class="error">Not configured yet:</p><ul>${problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul><p class="muted">Set the environment variables and restart. See the README.</p>`
        : `<p>Running. Add this URL as a custom connector in Claude:</p><p><code>${esc(mcpUrl.href)}</code></p>
           <p class="muted">${banks.length ? `Connected banks:<ul>${banks.join("")}</ul>` : "No bank connected yet. In Claude, say “connect my bank”."}</p>`,
    ),
  );
});

app.get("/healthz", (_req, res) => void res.json({ ok: true, version: VERSION, configured: isConfigured() }));

app.get("/privacy", (_req, res) =>
  void res.type("html").send(
    page(
      "Privacy",
      `<p>This server is operated by its owner to access the owner's own bank accounts. It is not offered as a service to anyone else.</p>
       <p>Account identifiers and consent references from Enable Banking are stored on the server so the owner's assistant can fetch balances and transactions on request. Transactions and balances themselves are not stored. No data is shared with third parties and nothing is collected about visitors.</p>`,
    ),
  ),
);

app.get("/terms", (_req, res) =>
  void res.type("html").send(page("Terms", `<p>Personal software run by its owner for their own non-commercial use, under Enable Banking's terms for individual use of their production environment.</p>`)),
);

// --- OAuth server for the MCP connector (single user) ---

app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: baseUrl,
    resourceServerUrl: mcpUrl,
    resourceName: "openbanking-mcp",
    scopesSupported: ["bank:read"],
    clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
  }),
);

app.post("/login", express.urlencoded({ extended: false }), (req, res) => {
  const { request, password } = req.body as Record<string, string | undefined>;
  const result = provider.completeLogin(String(request ?? ""), String(password ?? ""), req.ip ?? "unknown");
  if ("redirect" in result) return void res.redirect(302, result.redirect);
  if (result.requestId) return void res.status(401).type("html").send(loginPage({ requestId: result.requestId, error: result.error }));
  res.status(400).type("html").send(page("Sign in", `<p class="error">${esc(result.error)}</p>`));
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
  const failed = (msg: string) => res.status(400).type("html").send(page("Bank not connected", `<p class="error">${esc(msg)}</p><p class="muted">Go back to Claude and try again.</p>`));

  if (error || !code) return void failed(error_description || error || "The bank did not return an authorization code.");
  if (!pending) return void failed("Unknown or expired authorization. Start again from Claude.");

  try {
    const session = await eb.createSession(code);
    store().addSession(session);
    log(`bank connected: ${session.aspsp.name}, ${session.accounts.length} account(s)`);
    res.type("html").send(
      page(
        "Bank connected",
        `<p><b>${esc(session.aspsp.name)}</b> is linked with ${session.accounts.length} account${session.accounts.length === 1 ? "" : "s"}.</p>
         <ul>${session.accounts.map((a) => `<li>${esc(a.name ?? a.product ?? a.uid)} · ${esc(a.currency)}</li>`).join("")}</ul>
         <p class="muted">Consent valid until ${esc(session.access.valid_until.slice(0, 10))}. You can close this tab and go back to Claude.</p>`,
      ),
    );
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
