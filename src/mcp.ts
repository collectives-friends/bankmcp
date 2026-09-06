// MCP server over the Dabba ledger, so Claude Code (or any MCP client) can
// answer questions from the real numbers:  node --env-file=.env src/mcp.ts
// Nothing here may write to stdout except the transport — stdout is the wire.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { config } from "./config.ts";
import { listAccounts, listTransactions } from "./db.ts";
import { listCategories, setCategory, addRule, applyRules } from "./categorize.ts";
import { listRecurring } from "./recurring.ts";
import { forecast, netWorth, netWorthHistory, pnl, spendingOverview, anomalies } from "./analytics.ts";
import { listBriefings } from "./briefing.ts";

const server = new McpServer({ name: "dabba", version: "0.1.0" });

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

server.registerTool(
  "list_accounts",
  { description: "All linked bank accounts with current balance, holder, kind (asset/liability), owner (personal/joint) and consent status." },
  async () => json(listAccounts()),
);

server.registerTool(
  "net_worth",
  {
    description: "Net worth now (assets, liabilities, liquid) and a daily history.",
    inputSchema: { days: z.number().int().min(7).max(730).default(90).describe("Days of history") },
  },
  async ({ days }) => json({ now: netWorth(), history: netWorthHistory(days) }),
);

server.registerTool(
  "pnl",
  {
    description: "Monthly profit & loss: income, expenses, net and savings rate per month, with signed totals per category. Internal transfers are excluded.",
    inputSchema: {
      months: z.number().int().min(1).max(36).default(6),
      owner: z.enum(["personal", "joint"]).optional().describe("Restrict to personal or joint accounts"),
    },
  },
  async ({ months, owner }) => json(pnl(months, { owner })),
);

server.registerTool(
  "spending_overview",
  {
    description: "Spending by category over the last complete months, month-over-month change, subscription totals and a ranked list of where to cut with yearly impact.",
    inputSchema: { months: z.number().int().min(1).max(12).default(3) },
  },
  async ({ months }) => json(spendingOverview(months)),
);

server.registerTool(
  "search_transactions",
  {
    description: "Search transactions. Amounts are signed (negative = money out). Returns newest first.",
    inputSchema: {
      q: z.string().optional().describe("Substring of counterparty, description or amount"),
      category: z.string().optional().describe("Category id, or 'uncategorized'"),
      account: z.string().optional().describe("Account uid"),
      from: z.string().optional().describe("YYYY-MM-DD"),
      to: z.string().optional().describe("YYYY-MM-DD"),
      include_internal: z.boolean().default(false),
      limit: z.number().int().min(1).max(2000).default(200),
    },
  },
  async ({ q, category, account, from, to, include_internal, limit }) =>
    json(listTransactions({ q, category, accountUid: account, from, to, includeInternal: include_internal, limit })),
);

server.registerTool(
  "categories",
  { description: "The chart of accounts: category ids, names and kinds (income/expense/transfer)." },
  async () => json(listCategories()),
);

server.registerTool(
  "set_category",
  {
    description: "Set the category of one transaction, optionally adding a rule so future transactions matching the pattern get the same category.",
    inputSchema: {
      transaction_id: z.string(),
      category: z.string().describe("Category id from `categories`"),
      rule_pattern: z.string().optional().describe("Case-insensitive substring of counterparty/description to turn into a rule"),
    },
  },
  async ({ transaction_id, category, rule_pattern }) => {
    setCategory(transaction_id, category);
    let applied = 0;
    if (rule_pattern) {
      addRule(rule_pattern, category);
      applied = applyRules({ force: true });
    }
    return json({ ok: true, rule_applied_to: applied });
  },
);

server.registerTool(
  "recurring",
  { description: "Detected recurring payments and income (rent, subscriptions, salary): cadence, average amount, next expected date, yearly cost." },
  async () => json(listRecurring()),
);

server.registerTool(
  "forecast",
  {
    description: "Cash-flow forecast: projected liquid balance day by day from recurring items plus baseline spending, upcoming bills, runway in months.",
    inputSchema: { days: z.number().int().min(7).max(365).default(90) },
  },
  async ({ days }) => {
    const f = forecast(days);
    return json({ ...f, points: f.points.filter((_, i) => i % 7 === 6 || i === f.points.length - 1) });
  },
);

server.registerTool(
  "anomalies",
  {
    description: "Duplicate charges, unusually large payments and new merchants in a date range.",
    inputSchema: { from: z.string().describe("YYYY-MM-DD"), to: z.string().describe("YYYY-MM-DD") },
  },
  async ({ from, to }) => json(anomalies(from, to)),
);

server.registerTool("latest_briefing", { description: "The most recent weekly CFO briefing (markdown)." }, async () => {
  const [b] = listBriefings(1);
  return { content: [{ type: "text", text: b ? b.markdown : "No briefing generated yet." }] };
});

const readOnly = new DatabaseSync(config.dbPath, { readOnly: true });
server.registerTool(
  "query_sql",
  {
    description:
      "Run a read-only SQL query against the ledger (SQLite). Tables: accounts, sessions, balances, balance_snapshots, transactions (amount signed; is_internal; category; booking_date), categories, category_rules, recurring, budgets, briefings.",
    inputSchema: { sql: z.string().describe("A single SELECT or WITH statement") },
  },
  async ({ sql }) => {
    const trimmed = sql.trim().replace(/;+$/, "");
    if (!/^(select|with)\b/i.test(trimmed) || /;/.test(trimmed)) return json({ error: "Only a single SELECT/WITH statement is allowed." });
    try {
      return json(readOnly.prepare(trimmed).all().slice(0, 500));
    } catch (err) {
      return json({ error: String(err) });
    }
  },
);

await server.connect(new StdioServerTransport());
