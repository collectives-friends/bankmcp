import { db } from "./db.ts";
import { anomalies, forecast, netWorth, netWorthHistory, pnl, spendingOverview } from "./analytics.ts";
import { listRecurring } from "./recurring.ts";
import { listCategories } from "./categorize.ts";

const dayMs = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export interface BriefingFacts {
  period: { start: string; end: string };
  netWorth: { net: number; assets: number; liabilities: number; changeWeek: number | null; currency: string } | null;
  week: { income: number; expenses: number; net: number; byCategory: Array<{ category: string; name: string; amount: number; vsAvgPct: number | null }> };
  monthToDate: { month: string; income: number; expenses: number; budgetStatus: Array<{ category: string; name: string; spent: number; budget: number; pct: number }> };
  anomalies: ReturnType<typeof anomalies>;
  upcoming: Array<{ date: string; label: string; amount: number }>;
  runway: { months: number | null; monthlyBurn: number; liquid: number };
  forecastWarnings: string[];
  topOpportunities: Array<{ title: string; detail: string; yearlyImpact: number }>;
  newRecurring: Array<{ label: string; cadence: string; amount: number }>;
}

const kr = (n: number) => `${Math.round(n).toLocaleString("da-DK")} kr`;

export function buildFacts(end = isoDay(new Date()), currency = "DKK"): BriefingFacts {
  const start = isoDay(new Date(Date.parse(end) - 6 * dayMs));
  const prevStart = isoDay(new Date(Date.parse(start) - 28 * dayMs));
  const names = new Map(listCategories().map((c) => [c.id, c.name]));
  const kinds = new Map(listCategories().map((c) => [c.id, c.kind]));

  const weekRows = db
    .prepare(
      `SELECT COALESCE(category, 'uncategorized') AS category, SUM(amount) AS amount FROM transactions
       WHERE status = 'BOOK' AND is_internal = 0 AND currency = ? AND booking_date BETWEEN ? AND ? GROUP BY category`,
    )
    .all(currency, start, end) as Array<{ category: string; amount: number }>;
  // A weekly comparison only makes sense for categories that are spent on most
  // weeks (groceries, eating out). Rent lands once a month and would always
  // read as "+300%", so those categories get no percentage.
  const prevRows = db
    .prepare(
      `SELECT COALESCE(category, 'uncategorized') AS category, SUM(amount) / 4.0 AS amount,
              COUNT(DISTINCT strftime('%Y-%W', booking_date)) AS weeks
       FROM transactions
       WHERE status = 'BOOK' AND is_internal = 0 AND currency = ? AND booking_date >= ? AND booking_date < ? GROUP BY category`,
    )
    .all(currency, prevStart, start) as Array<{ category: string; amount: number; weeks: number }>;
  const prevAvg = new Map(prevRows.filter((r) => r.weeks >= 3).map((r) => [r.category, r.amount]));

  let income = 0;
  let expenses = 0;
  const byCategory = weekRows
    .map((r) => {
      const isIncome = kinds.get(r.category) === "income" || (r.category === "uncategorized" && r.amount > 0);
      if (isIncome) income += r.amount;
      else expenses += r.amount;
      const prev = prevAvg.get(r.category);
      // Compare magnitudes: spending 1,200 vs a usual 400 is +200%, regardless of sign.
      const vsAvgPct = prev && Math.abs(prev) > 50 ? (Math.abs(r.amount) - Math.abs(prev)) / Math.abs(prev) : null;
      return { category: r.category, name: names.get(r.category) ?? "Uncategorized", amount: r.amount, vsAvgPct };
    })
    .filter((r) => kinds.get(r.category) !== "income")
    .sort((a, b) => a.amount - b.amount);

  const nwNow = netWorth().find((n) => n.currency === currency) ?? null;
  const history = netWorthHistory(14, currency);
  const weekAgo = history.find((p) => p.date <= start) ?? history[0];
  const nw = nwNow ? { net: nwNow.net, assets: nwNow.assets, liabilities: nwNow.liabilities, changeWeek: weekAgo ? nwNow.net - weekAgo.net : null, currency } : null;

  const { months, budgets } = pnl(1);
  const mtd = months[months.length - 1];
  const budgetStatus = Object.entries(budgets)
    .map(([category, budget]) => {
      const spent = -(mtd?.byCategory[category] ?? 0);
      return { category, name: names.get(category) ?? category, spent, budget, pct: budget > 0 ? spent / budget : 0 };
    })
    .sort((a, b) => b.pct - a.pct);

  const fc = forecast(30, currency);
  const overview = spendingOverview(3);
  const newRecurring = listRecurring({ activeOnly: true })
    .filter((r) => r.first_date >= isoDay(new Date(Date.parse(end) - 45 * dayMs)) && r.avg_amount < 0)
    .map((r) => ({ label: r.label, cadence: r.cadence, amount: r.avg_amount }));

  return {
    period: { start, end },
    netWorth: nw,
    week: { income, expenses, net: income + expenses, byCategory },
    monthToDate: { month: mtd?.month ?? end.slice(0, 7), income: mtd?.income ?? 0, expenses: mtd?.expenses ?? 0, budgetStatus },
    anomalies: anomalies(start, end),
    upcoming: fc.upcoming.filter((u) => u.date <= isoDay(new Date(Date.parse(end) + 14 * dayMs))).map((u) => ({ date: u.date, label: u.label, amount: u.amount })),
    runway: { months: fc.runwayMonths, monthlyBurn: fc.monthlyBurn, liquid: fc.start },
    forecastWarnings: fc.warnings,
    topOpportunities: overview.opportunities.slice(0, 3).map((o) => ({ title: o.title, detail: o.detail, yearlyImpact: o.yearlyImpact })),
    newRecurring,
  };
}

/** Deterministic Markdown rendering — always produced, even without an AI narrative. */
export function renderMarkdown(f: BriefingFacts): string {
  const lines: string[] = [];
  lines.push(`# Weekly briefing · ${f.period.start} → ${f.period.end}`, "");

  if (f.netWorth) {
    const chg = f.netWorth.changeWeek == null ? "" : ` (${f.netWorth.changeWeek >= 0 ? "+" : ""}${kr(f.netWorth.changeWeek)} this week)`;
    lines.push(`**Net worth:** ${kr(f.netWorth.net)}${chg} — assets ${kr(f.netWorth.assets)}, liabilities ${kr(f.netWorth.liabilities)}`);
  }
  lines.push(`**This week:** in ${kr(f.week.income)}, out ${kr(-f.week.expenses)}, net ${f.week.net >= 0 ? "+" : ""}${kr(f.week.net)}`);
  lines.push(`**Runway:** ${f.runway.months == null ? "n/a" : `${f.runway.months.toFixed(1)} months`} at ${kr(f.runway.monthlyBurn)}/month burn, ${kr(f.runway.liquid)} liquid`, "");

  lines.push("## Spending this week");
  for (const c of f.week.byCategory.slice(0, 8)) {
    const vs = c.vsAvgPct == null ? "" : Math.abs(c.vsAvgPct) > 5 ? " · far above the usual week" : ` · ${c.vsAvgPct >= 0 ? "+" : ""}${(c.vsAvgPct * 100).toFixed(0)}% vs weekly avg`;
    lines.push(`- ${c.name}: ${kr(-c.amount)}${vs}`);
  }
  lines.push("");

  if (f.monthToDate.budgetStatus.length) {
    lines.push(`## Budget, ${f.monthToDate.month} to date`);
    for (const b of f.monthToDate.budgetStatus) lines.push(`- ${b.name}: ${kr(b.spent)} of ${kr(b.budget)} (${(b.pct * 100).toFixed(0)}%)${b.pct > 1 ? " ⚠️ over" : b.pct > 0.8 ? " · close" : ""}`);
    lines.push("");
  }

  if (f.anomalies.length) {
    lines.push("## Worth a look");
    for (const a of f.anomalies.slice(0, 8)) lines.push(`- ${a.title} — ${a.detail}`);
    lines.push("");
  }

  if (f.newRecurring.length) {
    lines.push("## New recurring charges");
    for (const r of f.newRecurring) lines.push(`- ${r.label}: ${kr(-r.amount)} ${r.cadence}`);
    lines.push("");
  }

  if (f.upcoming.length) {
    lines.push("## Coming up (14 days)");
    for (const u of f.upcoming) lines.push(`- ${u.date}: ${u.label} ${u.amount >= 0 ? "+" : ""}${kr(u.amount)}`);
    lines.push("");
  }
  for (const w of f.forecastWarnings) lines.push(`> ⚠️ ${w}`);
  if (f.forecastWarnings.length) lines.push("");

  if (f.topOpportunities.length) {
    lines.push("## Where to cut");
    for (const o of f.topOpportunities) lines.push(`- **${o.title}** (≈ ${kr(o.yearlyImpact)}/year): ${o.detail}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** Optional: a short CFO-style narrative on top of the facts. Skipped without credentials. */
export async function narrate(facts: BriefingFacts): Promise<string | null> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return null;
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const response = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 2000,
    system:
      "You are the CFO of a one-household company, writing the Monday note to the owner. Plain, direct, specific to the numbers given. Three short paragraphs: how the week went, what needs a decision, what to do this week. No headings, no bullet points, no generic advice. Amounts in kr, rounded.",
    messages: [{ role: "user", content: JSON.stringify(facts) }],
  });
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  return text || null;
}

export async function deliverToWebhook(markdown: string): Promise<boolean> {
  const url = process.env.BRIEFING_WEBHOOK_URL;
  if (!url) return false;
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: markdown }) });
  return res.ok;
}

export async function generateBriefing(opts: { deliver?: boolean } = {}): Promise<{ id: number; markdown: string; facts: BriefingFacts; delivered: boolean }> {
  const facts = buildFacts();
  let markdown = renderMarkdown(facts);
  const story = await narrate(facts).catch(() => null);
  if (story) markdown = markdown.replace("\n\n", `\n\n${story}\n\n`);
  const res = db.prepare(`INSERT INTO briefings (period_start, period_end, facts, markdown) VALUES (?, ?, ?, ?)`).run(facts.period.start, facts.period.end, JSON.stringify(facts), markdown);
  const delivered = opts.deliver ? await deliverToWebhook(markdown).catch(() => false) : false;
  return { id: Number(res.lastInsertRowid), markdown, facts, delivered };
}

export function listBriefings(limit = 12) {
  return db.prepare(`SELECT id, period_start, period_end, markdown, created_at FROM briefings ORDER BY id DESC LIMIT ?`).all(limit) as Array<{ id: number; period_start: string; period_end: string; markdown: string; created_at: string }>;
}
