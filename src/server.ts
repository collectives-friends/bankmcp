import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { config, isConfigured, setupProblems, tlsOptions } from "./config.ts";
import { eb, EnableBankingError, type Aspsp } from "./enablebanking.ts";
import * as store from "./db.ts";
import { syncAccount, syncAll } from "./sync.ts";
import { postProcess } from "./pipeline.ts";
import { addRule, applyRules, deleteRule, listCategories, listRules, setCategory, uncategorizedMerchants } from "./categorize.ts";
import { unmarkInternal } from "./transfers.ts";
import { listRecurring } from "./recurring.ts";
import { forecast, monthClose, netWorth, netWorthHistory, pnl, setBudget, spendingOverview } from "./analytics.ts";
import { generateBriefing, listBriefings } from "./briefing.ts";
import { scheduleStatus } from "./schedule.ts";

const tls = tlsOptions();
const app = Fastify({ logger: { level: "info" }, ...(tls ? { https: tls } : {}) });

// Authorization flows we have started but not finished, keyed by the `state`
// we sent to the bank. In-memory is fine: the redirect comes back to this
// same process within minutes.
const pendingAuth = new Map<string, { aspsp: Aspsp; startedAt: number }>();

const MAX_CONSENT_DAYS = 180;

function requireConfigured() {
  if (!isConfigured()) {
    const err = new Error(`App is not configured: ${setupProblems().join("; ")}`) as Error & { statusCode: number };
    err.statusCode = 503;
    throw err;
  }
}

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof EnableBankingError) {
    app.log.warn({ status: err.status, body: err.body }, "Enable Banking error");
    return reply.status(err.status >= 500 ? 502 : err.status).send({ error: "enablebanking", status: err.status, detail: safeJson(err.body) });
  }
  const e = err as Error & { statusCode?: number };
  const status = e.statusCode ?? 500;
  if (status >= 500) app.log.error(e);
  return reply.status(status).send({ error: e.message });
});

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// --- UI ---

app.get("/", async (_req, reply) => {
  reply.type("text/html").send(readFileSync(new URL("../public/index.html", import.meta.url), "utf8"));
});

// Enable Banking's production registration form requires these URLs even for
// a single-user app activated in restricted mode.
const legalPage = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title} – Dabba</title>
   <body style="font: 16px/1.5 system-ui; max-width: 640px; margin: 48px auto; padding: 0 20px">
   <h1>${title}</h1>${body}</body>`;

app.get("/privacy", async (_req, reply) => {
  reply.type("text/html").send(
    legalPage(
      "Privacy policy",
      `<p>Dabba is a private, single-user application. It is used only by its owner to view their own bank accounts.</p>
       <p>Account and transaction data is retrieved from the owner's banks via Enable Banking and stored in a database on the owner's own computer. It is not shared with anyone, not sent to any other service, and can be deleted at any time by removing the database file.</p>`,
    ),
  );
});

app.get("/terms", async (_req, reply) => {
  reply.type("text/html").send(
    legalPage(
      "Terms of service",
      `<p>Dabba is personal software operated by its owner for their own non-commercial use. It is not offered as a service to anyone else.</p>`,
    ),
  );
});

// --- Status ---

app.get("/api/status", async () => {
  const problems = setupProblems();
  let application: unknown = null;
  let apiError: string | null = null;
  if (problems.length === 0) {
    try {
      application = await eb.getApplication();
    } catch (err) {
      apiError = err instanceof EnableBankingError ? `${err.status} ${err.body.slice(0, 200)}` : String(err);
    }
  }
  return { configured: problems.length === 0, problems, application, apiError, country: config.country, counts: store.counts() };
});

// --- Connecting a bank ---

app.get<{ Querystring: { country?: string } }>("/api/banks", async (req) => {
  requireConfigured();
  const country = (req.query.country ?? config.country).toUpperCase();
  const banks = await eb.listAspsps(country);
  return banks
    .filter((b) => !b.psu_types || b.psu_types.includes("personal"))
    .sort((a, b) => a.name.localeCompare(b.name));
});

app.post<{ Body: { name: string; country: string } }>("/api/connect", async (req, reply) => {
  requireConfigured();
  const { name, country } = req.body ?? {};
  if (!name || !country) return reply.status(400).send({ error: "name and country are required" });

  const aspsp = (await eb.listAspsps(country)).find((b) => b.name === name);
  if (!aspsp) return reply.status(404).send({ error: `Bank ${name} (${country}) not found` });

  const maxSeconds = aspsp.maximum_consent_validity ?? MAX_CONSENT_DAYS * 86_400;
  const validUntil = new Date(Date.now() + Math.min(maxSeconds, MAX_CONSENT_DAYS * 86_400) * 1000 - 60_000);

  const state = randomUUID();
  pendingAuth.set(state, { aspsp, startedAt: Date.now() });

  const auth = await eb.startAuthorization({ aspsp, state, redirectUrl: `${config.baseUrl}/callback`, validUntil });
  return { url: auth.url };
});

app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>("/callback", async (req, reply) => {
  const { code, state, error, error_description } = req.query;
  const pending = state ? pendingAuth.get(state) : undefined;
  if (state) pendingAuth.delete(state);

  if (error || !code) {
    const msg = error_description || error || "Bank did not return an authorization code";
    return reply.redirect(`/?error=${encodeURIComponent(msg)}`);
  }
  if (!pending) return reply.redirect(`/?error=${encodeURIComponent("Unknown or expired authorization state. Please try connecting again.")}`);

  const session = await eb.createSession(code);
  store.saveSession(session);
  app.log.info({ session: session.session_id, bank: session.aspsp.name, accounts: session.accounts.length }, "bank connected");

  // Initial sync right away so the dashboard isn't empty on return.
  for (const account of session.accounts) await syncAccount(account.uid, account.name ?? account.product ?? null);
  await postProcess();

  return reply.redirect(`/?connected=${encodeURIComponent(session.aspsp.name)}`);
});

// --- Data ---

app.get("/api/accounts", async () => store.listAccounts());

app.patch<{ Params: { uid: string }; Body: { kind?: "asset" | "liability" | "credit_card"; owner?: string; display_name?: string; include_in_total?: boolean } }>(
  "/api/accounts/:uid",
  async (req) => {
    const b = req.body ?? {};
    store.updateAccount(req.params.uid, {
      kind: b.kind,
      owner: b.owner,
      display_name: b.display_name,
      include_in_total: b.include_in_total === undefined ? undefined : b.include_in_total ? 1 : 0,
    });
    return { ok: true };
  },
);

// --- Ledger: categories, rules, recurring ---

app.get("/api/categories", async () => ({ categories: listCategories(), rules: listRules(), uncategorized: uncategorizedMerchants(50) }));

app.post<{ Body: { pattern: string; category: string } }>("/api/rules", async (req, reply) => {
  const { pattern, category } = req.body ?? {};
  if (!pattern?.trim() || !category) return reply.status(400).send({ error: "pattern and category are required" });
  const rule = addRule(pattern, category);
  const applied = applyRules({ force: true });
  return { rule, applied };
});

app.delete<{ Params: { id: string } }>("/api/rules/:id", async (req) => {
  deleteRule(Number(req.params.id));
  return { applied: applyRules({ force: true }) };
});

app.patch<{ Params: { id: string }; Body: { category?: string | null; internal?: boolean; rule?: string } }>("/api/transactions/:id", async (req, reply) => {
  const tx = store.getTransaction(req.params.id);
  if (!tx) return reply.status(404).send({ error: "transaction not found" });
  const b = req.body ?? {};
  if (b.internal === false) unmarkInternal(tx.id);
  if (b.category !== undefined) setCategory(tx.id, b.category);
  let applied = 0;
  if (b.rule && b.category) {
    addRule(b.rule, b.category);
    applied = applyRules({ force: true });
  }
  return { ok: true, applied, transaction: store.getTransaction(tx.id) };
});

app.get("/api/recurring", async () => listRecurring());

app.post<{ Body: { ai?: boolean } }>("/api/process", async (req) => postProcess({ ai: req.body?.ai }));

// --- Statements ---

app.get<{ Querystring: { months?: string; owner?: string } }>("/api/pnl", async (req) => pnl(Number(req.query.months ?? 6), { owner: scopeOf(req.query.owner) }));

app.put<{ Params: { category: string }; Body: { monthly_limit: number | null } }>("/api/budgets/:category", async (req) => {
  setBudget(req.params.category, req.body?.monthly_limit ?? null);
  return { ok: true };
});

const scopeOf = (v?: string) => (v === "personal" || v === "joint" ? v : undefined);

app.get<{ Querystring: { months?: string; owner?: string } }>("/api/spending", async (req) => spendingOverview(Number(req.query.months ?? 3), scopeOf(req.query.owner)));

app.get<{ Querystring: { owner?: string } }>("/api/month", async (req) => monthClose("DKK", scopeOf(req.query.owner)));

app.put<{ Body: { target_savings_rate?: number } }>("/api/settings", async (req, reply) => {
  const t = req.body?.target_savings_rate;
  if (t === undefined || Number.isNaN(t) || t < 0 || t > 0.95) return reply.status(400).send({ error: "target_savings_rate must be between 0 and 0.95" });
  store.setSetting("target_savings_rate", String(t));
  return { ok: true };
});

app.get<{ Querystring: { days?: string; currency?: string } }>("/api/networth", async (req) => ({
  now: netWorth(),
  history: netWorthHistory(Number(req.query.days ?? 90), req.query.currency ?? "DKK"),
}));

app.get<{ Querystring: { days?: string; currency?: string } }>("/api/forecast", async (req) => forecast(Number(req.query.days ?? 90), req.query.currency ?? "DKK"));

// --- Briefing ---

app.get("/api/briefings", async () => ({ briefings: listBriefings(), schedule: scheduleStatus() }));

app.post("/api/briefings", async () => {
  const b = await generateBriefing({ deliver: true });
  return { id: b.id, markdown: b.markdown, delivered: b.delivered };
});

app.get("/api/sessions", async () => store.listSessions());

app.delete<{ Params: { id: string } }>("/api/sessions/:id", async (req) => {
  requireConfigured();
  try {
    await eb.deleteSession(req.params.id);
  } catch (err) {
    if (!(err instanceof EnableBankingError && err.status === 404)) throw err;
  }
  store.deleteSession(req.params.id);
  return { ok: true };
});

app.get<{ Querystring: { account?: string; q?: string; category?: string; internal?: string; from?: string; to?: string; limit?: string; offset?: string } }>(
  "/api/transactions",
  async (req) => {
    const { account, q, category, internal, from, to, limit, offset } = req.query;
    return store.listTransactions({
      accountUid: account || undefined,
      q: q?.trim() || undefined,
      category: category || undefined,
      includeInternal: internal === "1",
      from: from || undefined,
      to: to || undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  },
);

app.post("/api/sync", async () => {
  requireConfigured();
  return await syncAll();
});

// --- Start ---

// Never expose this to the network: it holds your bank data and there is no login.
await app.listen({ port: config.port, host: "127.0.0.1" });
app.log.info(`Dabba is at ${config.baseUrl}${tls ? " (https)" : ""}`);

if (!isConfigured()) {
  app.log.warn(`Not configured yet: ${setupProblems().join("; ")}. Open ${config.baseUrl} for setup instructions.`);
}
