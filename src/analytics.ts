import { db, getSetting, listAccounts } from "./db.ts";
import { listCategories } from "./categorize.ts";
import { listRecurring } from "./recurring.ts";

const dayMs = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const today = () => isoDay(new Date());
const daysAgo = (n: number) => isoDay(new Date(Date.now() - n * dayMs));
const monthKey = (iso: string) => iso.slice(0, 7);

// ---------------------------------------------------------------------------
// Balance sheet
// ---------------------------------------------------------------------------

export interface NetWorth {
  currency: string;
  assets: number;
  liabilities: number; // negative number
  net: number;
  liquid: number; // spendable: asset accounts included in total, positive balances
  asOf: string | null;
}

export function netWorth(): NetWorth[] {
  const byCur = new Map<string, NetWorth>();
  for (const a of listAccounts()) {
    if (a.balance == null || !a.include_in_total) continue;
    const nw = byCur.get(a.currency) ?? { currency: a.currency, assets: 0, liabilities: 0, net: 0, liquid: 0, asOf: null };
    if (a.balance >= 0 && a.kind === "asset") nw.assets += a.balance;
    else if (a.balance >= 0) nw.assets += a.balance; // a positive balance on a credit line is still ours
    else nw.liabilities += a.balance;
    if (a.kind === "asset" && a.balance > 0) nw.liquid += a.balance;
    nw.net = nw.assets + nw.liabilities;
    if (a.balance_updated_at && (!nw.asOf || a.balance_updated_at > nw.asOf)) nw.asOf = a.balance_updated_at;
    byCur.set(a.currency, nw);
  }
  return [...byCur.values()];
}

/** Records today's balance for every account (called after each sync). */
export function snapshotBalances(): number {
  const stmt = db.prepare(`
    INSERT INTO balance_snapshots (date, account_uid, amount, currency, source)
    VALUES (?, ?, ?, ?, 'sync')
    ON CONFLICT(date, account_uid) DO UPDATE SET amount = excluded.amount, source = 'sync'
  `);
  let n = 0;
  for (const a of listAccounts()) {
    if (a.balance == null) continue;
    stmt.run(today(), a.uid, a.balance, a.currency);
    n++;
  }
  return n;
}

/**
 * Reconstructs past end-of-day balances from the bank's balance_after_transaction
 * field, so the net-worth chart has history from day one instead of starting
 * at the first sync. Never overwrites a real sync snapshot.
 */
export function backfillSnapshots(): number {
  const rows = db
    .prepare(
      `SELECT t.account_uid, t.booking_date AS date, t.currency,
              json_extract(t.raw, '$.balance_after_transaction.amount') AS after, t.rowid AS rid
       FROM transactions t
       WHERE t.status = 'BOOK' AND t.booking_date IS NOT NULL AND after IS NOT NULL
       ORDER BY t.account_uid, t.booking_date, t.rowid`,
    )
    .all() as unknown as Array<{ account_uid: string; date: string; currency: string; after: string; rid: number }>;

  // Banks return newest first, so within a day the lowest rowid is the latest balance.
  const eod = new Map<string, { amount: number; currency: string; rid: number }>();
  for (const r of rows) {
    const k = `${r.date}|${r.account_uid}`;
    const cur = eod.get(k);
    if (!cur || r.rid < cur.rid) eod.set(k, { amount: Number(r.after), currency: r.currency, rid: r.rid });
  }
  const stmt = db.prepare(`INSERT OR IGNORE INTO balance_snapshots (date, account_uid, amount, currency, source) VALUES (?, ?, ?, ?, 'backfill')`);
  let n = 0;
  db.exec("BEGIN");
  for (const [k, v] of eod) {
    const [date, uid] = k.split("|") as [string, string];
    n += Number(stmt.run(date, uid, v.amount, v.currency).changes);
  }
  db.exec("COMMIT");
  return n;
}

export interface NetWorthPoint {
  date: string;
  net: number;
  assets: number;
  liabilities: number;
}

/** Daily net-worth series: for each day, every account's latest known balance on or before it. */
export function netWorthHistory(days = 90, currency = "DKK"): NetWorthPoint[] {
  const accounts = listAccounts().filter((a) => a.currency === currency && a.include_in_total);
  const uids = new Set(accounts.map((a) => a.uid));
  const start = daysAgo(days);
  const snaps = db
    .prepare(`SELECT date, account_uid, amount FROM balance_snapshots WHERE currency = ? ORDER BY date`)
    .all(currency) as unknown as Array<{ date: string; account_uid: string; amount: number }>;

  const latest = new Map<string, number>(); // account -> balance carried forward
  const byDate = new Map<string, Array<{ account_uid: string; amount: number }>>();
  for (const s of snaps) {
    if (!uids.has(s.account_uid)) continue;
    // Accounts whose bank gives no running balance (so no backfill) are assumed
    // flat at their earliest known balance before their first snapshot.
    if (!latest.has(s.account_uid)) latest.set(s.account_uid, s.amount);
    if (s.date < start) latest.set(s.account_uid, s.amount);
    else (byDate.get(s.date) ?? byDate.set(s.date, []).get(s.date)!).push(s);
  }

  const points: NetWorthPoint[] = [];
  for (let d = new Date(start); isoDay(d) <= today(); d = new Date(d.getTime() + dayMs)) {
    const date = isoDay(d);
    for (const s of byDate.get(date) ?? []) latest.set(s.account_uid, s.amount);
    if (latest.size === 0) continue;
    let assets = 0;
    let liabilities = 0;
    for (const v of latest.values()) (v >= 0 ? (assets += v) : (liabilities += v));
    points.push({ date, net: assets + liabilities, assets, liabilities });
  }
  return points;
}

// ---------------------------------------------------------------------------
// P&L
// ---------------------------------------------------------------------------

export interface MonthPnl {
  month: string; // YYYY-MM
  income: number;
  expenses: number; // negative
  net: number;
  savingsRate: number | null;
  byCategory: Record<string, number>; // signed sums, key = category id or "uncategorized"
  complete: boolean; // false for the current month
}

/**
 * Scope handling. The household view (no owner) nets every internal transfer.
 * An owner view ("personal" or "joint") keeps the accounts of that owner and
 * re-counts internal transfers that *cross* the scope boundary: money leaving
 * the personal accounts for the shared ones is a real expense for the person
 * ("Contribution to shared accounts"), and on the shared side it is funding
 * ("Partner contributions"). Transfers inside the scope stay netted.
 */
export type Scope = "personal" | "joint" | undefined;

/** WHERE fragment (needs `t` = transactions, `a` = accounts) and the effective category expression for a scope. */
function scopeSql(owner: Scope): { where: string; params: string[]; categoryExpr: string } {
  if (!owner) return { where: "t.is_internal = 0", params: [], categoryExpr: "COALESCE(t.category, 'uncategorized')" };
  return {
    where: `a.owner = ? AND (t.is_internal = 0 OR EXISTS (
              SELECT 1 FROM transactions o JOIN accounts oa ON oa.uid = o.account_uid
              WHERE o.transfer_group = t.transfer_group AND o.id <> t.id AND oa.owner <> ?))`,
    params: [owner, owner],
    // Personal side: money sent to the shared accounts is a contribution, money
    // coming back is a reimbursement (you paid for something shared with your
    // own card). Shared side: money in is partner funding, money out to a
    // partner is a reimbursement.
    categoryExpr:
      owner === "personal"
        ? `CASE WHEN t.is_internal = 1 THEN (CASE WHEN t.amount < 0 THEN 'household_contribution' ELSE 'reimbursement_in' END) ELSE COALESCE(t.category, 'uncategorized') END`
        : `CASE WHEN t.is_internal = 1 THEN (CASE WHEN t.amount > 0 THEN 'contribution_in' ELSE 'reimbursement_out' END) ELSE COALESCE(t.category, 'uncategorized') END`,
  };
}

export function pnl(months = 6, opts: { owner?: Scope } = {}): { months: MonthPnl[]; categories: ReturnType<typeof listCategories>; budgets: Record<string, number> } {
  const cats = listCategories();
  const kind = new Map(cats.map((c) => [c.id, c.kind]));
  const from = `${monthKey(isoDay(new Date(new Date().setUTCMonth(new Date().getUTCMonth() - (months - 1)))))}-01`;
  const sc = scopeSql(opts.owner);
  const rows = db
    .prepare(
      `SELECT substr(t.booking_date, 1, 7) AS month, ${sc.categoryExpr} AS cat, SUM(t.amount) AS total
       FROM transactions t JOIN accounts a ON a.uid = t.account_uid
       WHERE t.status = 'BOOK' AND t.booking_date >= ? AND ${sc.where}
       GROUP BY month, cat ORDER BY month`,
    )
    .all(from, ...sc.params) as unknown as Array<{ month: string; cat: string; total: number }>;
  // Note: the alias is `cat`, not `category` — SQLite would otherwise resolve
  // GROUP BY to the raw transactions.category column and merge the buckets.

  const byMonth = new Map<string, MonthPnl>();
  const thisMonth = monthKey(today());
  for (const r of rows) {
    const m = byMonth.get(r.month) ?? { month: r.month, income: 0, expenses: 0, net: 0, savingsRate: null, byCategory: {}, complete: r.month < thisMonth };
    m.byCategory[r.cat] = (m.byCategory[r.cat] ?? 0) + r.total;
    const k = kind.get(r.cat);
    if (k === "income" || (r.cat === "uncategorized" && r.total > 0)) m.income += r.total;
    else m.expenses += r.total;
    byMonth.set(r.month, m);
  }
  for (const m of byMonth.values()) {
    m.net = m.income + m.expenses;
    m.savingsRate = m.income > 0 ? m.net / m.income : null;
  }
  const budgets = Object.fromEntries((db.prepare(`SELECT category, monthly_limit FROM budgets`).all() as Array<{ category: string; monthly_limit: number }>).map((b) => [b.category, b.monthly_limit]));
  return { months: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)), categories: cats, budgets };
}

export function setBudget(category: string, monthlyLimit: number | null): void {
  if (monthlyLimit == null) db.prepare(`DELETE FROM budgets WHERE category = ?`).run(category);
  else db.prepare(`INSERT INTO budgets (category, monthly_limit) VALUES (?, ?) ON CONFLICT(category) DO UPDATE SET monthly_limit = excluded.monthly_limit`).run(category, monthlyLimit);
}

// ---------------------------------------------------------------------------
// Spending overview & where to cut
// ---------------------------------------------------------------------------

export interface Opportunity {
  kind: "subscription" | "trend" | "fees" | "eating_out" | "p2p" | "unused" | "price_increase";
  title: string;
  detail: string;
  yearlyImpact: number; // positive DKK you would keep
  category?: string;
  recurringId?: string;
}

export interface SpendingOverview {
  windowMonths: number;
  monthlyAvgExpenses: number; // positive
  monthlyAvgIncome: number;
  categories: Array<{ id: string; name: string; monthlyAvg: number; lastMonth: number; prevMonth: number; changePct: number | null; share: number; budget: number | null }>;
  subscriptions: { count: number; monthly: number; yearly: number };
  opportunities: Opportunity[];
}

export function spendingOverview(windowMonths = 3, owner: Scope = undefined): SpendingOverview {
  const { months, categories } = pnl(windowMonths + 1, { owner });
  const complete = months.filter((m) => m.complete).slice(-windowMonths);
  const n = Math.max(complete.length, 1);
  const names = new Map(categories.map((c) => [c.id, c.name]));
  const kinds = new Map(categories.map((c) => [c.id, c.kind]));
  const budgets = Object.fromEntries((db.prepare(`SELECT category, monthly_limit FROM budgets`).all() as Array<{ category: string; monthly_limit: number }>).map((b) => [b.category, b.monthly_limit]));

  const totals = new Map<string, number>();
  for (const m of complete) for (const [c, v] of Object.entries(m.byCategory)) totals.set(c, (totals.get(c) ?? 0) + v);
  const last = complete[complete.length - 1];
  const prev = complete[complete.length - 2];

  const monthlyAvgExpenses = -complete.reduce((s, m) => s + m.expenses, 0) / n;
  const monthlyAvgIncome = complete.reduce((s, m) => s + m.income, 0) / n;

  const cats = [...totals.entries()]
    .filter(([id]) => kinds.get(id) !== "income" && id !== "internal")
    .map(([id, total]) => {
      const monthlyAvg = -total / n;
      const lastMonth = -(last?.byCategory[id] ?? 0);
      const prevMonth = -(prev?.byCategory[id] ?? 0);
      return {
        id,
        name: names.get(id) ?? (id === "uncategorized" ? "Uncategorized" : id),
        monthlyAvg,
        lastMonth,
        prevMonth,
        changePct: prevMonth > 0 ? (lastMonth - prevMonth) / prevMonth : null,
        share: monthlyAvgExpenses > 0 ? monthlyAvg / monthlyAvgExpenses : 0,
        budget: budgets[id] ?? null,
      };
    })
    .filter((c) => c.monthlyAvg > 0)
    .sort((a, b) => b.monthlyAvg - a.monthlyAvg);

  const ownerOf = new Map(listAccounts().map((a) => [a.uid, a.owner]));
  const recurring = listRecurring({ activeOnly: true }).filter((r) => r.avg_amount < 0 && (!owner || ownerOf.get(r.account_uid) === owner));
  const neverSuggestCancel = new Set(["housing", "insurance", "utilities", "kids", "savings", "health", "charity", "tax", "fees", "p2p", "groceries", "household_contribution"]);
  const subs = recurring.filter((r) => r.category === "subscriptions" || (r.cadence === "monthly" && Math.abs(r.avg_amount) < 600 && !neverSuggestCancel.has(r.category ?? "")));
  const subsYearly = subs.reduce((s, r) => s + -r.yearly_amount, 0);

  const opportunities: Opportunity[] = [];

  for (const r of subs) {
    opportunities.push({
      kind: "subscription",
      title: `Cancel ${r.label}`,
      detail: `${r.cadence}, about ${Math.abs(r.avg_amount).toFixed(0)} kr each time; ${r.occurrences} payments so far.`,
      yearlyImpact: -r.yearly_amount,
      category: r.category ?? undefined,
      recurringId: r.id,
    });
    if (Math.abs(r.last_amount) > Math.abs(r.avg_amount) * 1.1) {
      opportunities.push({
        kind: "price_increase",
        title: `${r.label} got more expensive`,
        detail: `Last charge ${Math.abs(r.last_amount).toFixed(0)} kr vs. usual ${Math.abs(r.avg_amount).toFixed(0)} kr.`,
        yearlyImpact: (Math.abs(r.last_amount) - Math.abs(r.avg_amount)) * (365.25 / r.interval_days),
        recurringId: r.id,
      });
    }
  }

  const notALever = new Set(["household_contribution", "reimbursement_out", "transfer_out", "tax", "savings", "uncategorized", "card_settlement"]);
  for (const c of cats) {
    if (notALever.has(c.id)) continue;
    if (c.changePct != null && c.changePct > 0.3 && c.lastMonth - c.prevMonth > 500) {
      opportunities.push({
        kind: "trend",
        title: `${c.name} is up ${(c.changePct * 100).toFixed(0)}%`,
        detail: `${c.lastMonth.toFixed(0)} kr last month vs. ${c.prevMonth.toFixed(0)} kr the month before. Bringing it back saves the difference.`,
        yearlyImpact: (c.lastMonth - c.prevMonth) * 12,
        category: c.id,
      });
    }
  }

  const fees = cats.find((c) => c.id === "fees");
  if (fees && fees.monthlyAvg > 50) {
    opportunities.push({
      kind: "fees",
      title: "Bank fees and interest",
      detail: `You pay about ${fees.monthlyAvg.toFixed(0)} kr a month in fees, interest and charges. Worth a call to the bank or moving the card.`,
      yearlyImpact: fees.monthlyAvg * 12,
      category: "fees",
    });
  }

  const eating = cats.find((c) => c.id === "eating_out");
  const groceries = cats.find((c) => c.id === "groceries");
  if (eating && eating.monthlyAvg > 1500) {
    const target = Math.max(eating.monthlyAvg * 0.6, groceries ? groceries.monthlyAvg * 0.3 : 0);
    opportunities.push({
      kind: "eating_out",
      title: "Eating out",
      detail: `About ${eating.monthlyAvg.toFixed(0)} kr a month${groceries ? ` versus ${groceries.monthlyAvg.toFixed(0)} kr on groceries` : ""}. Cutting it by 40% is the most common lever.`,
      yearlyImpact: (eating.monthlyAvg - target) * 12,
      category: "eating_out",
    });
  }

  const p2p = cats.find((c) => c.id === "p2p");
  if (p2p && p2p.monthlyAvg > 2000) {
    opportunities.push({
      kind: "p2p",
      title: "MobilePay and transfers to people",
      detail: `${p2p.monthlyAvg.toFixed(0)} kr a month leaves via MobilePay and person-to-person transfers. This is usually the least visible spending — worth categorizing what it actually buys.`,
      yearlyImpact: p2p.monthlyAvg * 12 * 0.2,
      category: "p2p",
    });
  }

  opportunities.sort((a, b) => b.yearlyImpact - a.yearlyImpact);

  return {
    windowMonths: complete.length,
    monthlyAvgExpenses,
    monthlyAvgIncome,
    categories: cats,
    subscriptions: { count: subs.length, monthly: subsYearly / 12, yearly: subsYearly },
    opportunities,
  };
}

// ---------------------------------------------------------------------------
// Cash-flow forecast and runway
// ---------------------------------------------------------------------------

export interface ForecastPoint {
  date: string;
  balance: number;
  events: Array<{ label: string; amount: number }>;
}

export interface Forecast {
  currency: string;
  start: number;
  days: number;
  baselineDaily: number; // negative: everyday spending not captured by recurring items
  points: ForecastPoint[];
  low: { date: string; balance: number };
  upcoming: Array<{ date: string; label: string; amount: number; cadence: string }>;
  runwayMonths: number | null;
  monthlyBurn: number; // positive
  warnings: string[];
}

export function forecast(days = 90, currency = "DKK"): Forecast {
  const nw = netWorth().find((n) => n.currency === currency);
  const start = nw?.liquid ?? 0;

  // Everyday spending = last 90 days of non-recurring, non-internal outflows.
  const base = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
       WHERE status = 'BOOK' AND is_internal = 0 AND recurring_id IS NULL AND amount < 0 AND currency = ? AND booking_date >= ?`,
    )
    .get(currency, daysAgo(90)) as { total: number };
  const baselineDaily = base.total / 90;

  const recurring = listRecurring({ activeOnly: true });
  const horizonEnd = daysAgo(-days);
  const eventsByDate = new Map<string, Array<{ label: string; amount: number; cadence: string }>>();
  for (const r of recurring) {
    let d = r.next_date < today() ? today() : r.next_date;
    while (d <= horizonEnd) {
      (eventsByDate.get(d) ?? eventsByDate.set(d, []).get(d)!).push({ label: r.label, amount: r.avg_amount, cadence: r.cadence });
      d = isoDay(new Date(Date.parse(d) + r.interval_days * dayMs));
    }
  }

  const points: ForecastPoint[] = [];
  let balance = start;
  let low = { date: today(), balance: start };
  for (let i = 1; i <= days; i++) {
    const date = daysAgo(-i);
    const events = eventsByDate.get(date) ?? [];
    balance += baselineDaily + events.reduce((s, e) => s + e.amount, 0);
    points.push({ date, balance, events: events.map((e) => ({ label: e.label, amount: e.amount })) });
    if (balance < low.balance) low = { date, balance };
  }

  const upcoming = [...eventsByDate.entries()]
    .filter(([d]) => d <= daysAgo(-30))
    .flatMap(([date, evs]) => evs.map((e) => ({ date, ...e })))
    .sort((a, b) => a.date.localeCompare(b.date));

  const burnRow = db
    .prepare(
      `SELECT COALESCE(-SUM(amount), 0) AS burn FROM transactions
       WHERE status = 'BOOK' AND is_internal = 0 AND amount < 0 AND currency = ? AND booking_date >= ? AND booking_date < ?`,
    )
    .get(currency, `${monthKey(daysAgo(92))}-01`, `${monthKey(today())}-01`) as { burn: number };
  const monthsCounted = Math.max(1, Math.round((Date.parse(`${monthKey(today())}-01`) - Date.parse(`${monthKey(daysAgo(92))}-01`)) / (30.44 * dayMs)));
  const monthlyBurn = burnRow.burn / monthsCounted;

  const warnings: string[] = [];
  if (low.balance < 0) warnings.push(`Projected to go negative on ${low.date} (${low.balance.toFixed(0)} ${currency}).`);
  else if (low.balance < monthlyBurn * 0.5) warnings.push(`Liquid balance dips to ${low.balance.toFixed(0)} ${currency} on ${low.date} — under half a month of spending.`);

  return {
    currency,
    start,
    days,
    baselineDaily,
    points,
    low,
    upcoming,
    runwayMonths: monthlyBurn > 0 ? start / monthlyBurn : null,
    monthlyBurn,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Anomalies (used by the weekly briefing)
// ---------------------------------------------------------------------------

export interface Anomaly {
  kind: "duplicate" | "large" | "new_merchant" | "price_increase";
  title: string;
  detail: string;
  amount: number;
  date: string;
  transactionId?: string;
}

export function anomalies(from: string, to: string): Anomaly[] {
  const out: Anomaly[] = [];
  const period = db
    .prepare(
      `SELECT id, amount, booking_date, counterparty, description, category FROM transactions
       WHERE status = 'BOOK' AND is_internal = 0 AND amount < 0 AND booking_date BETWEEN ? AND ? ORDER BY booking_date`,
    )
    .all(from, to) as unknown as Array<{ id: string; amount: number; booking_date: string; counterparty: string | null; description: string | null; category: string | null }>;

  // Duplicates: same merchant + same amount within 2 days.
  for (let i = 0; i < period.length; i++) {
    for (let j = i + 1; j < period.length; j++) {
      const a = period[i]!;
      const b = period[j]!;
      if (Math.abs(Date.parse(b.booking_date) - Date.parse(a.booking_date)) > 2 * dayMs) break;
      if (a.amount === b.amount && (a.counterparty ?? a.description) === (b.counterparty ?? b.description) && Math.abs(a.amount) >= 50) {
        out.push({ kind: "duplicate", title: `Possible duplicate: ${a.counterparty ?? a.description}`, detail: `${Math.abs(a.amount).toFixed(0)} kr charged on ${a.booking_date} and again on ${b.booking_date}.`, amount: a.amount, date: b.booking_date, transactionId: b.id });
      }
    }
  }

  // Large: more than 3x the category's typical charge over the last 6 months, and at least 1,000.
  const typical = new Map<string, number>();
  for (const r of db
    .prepare(`SELECT category, amount FROM transactions WHERE status = 'BOOK' AND is_internal = 0 AND amount < 0 AND booking_date >= ? AND booking_date < ?`)
    .all(daysAgo(180), from) as Array<{ category: string | null; amount: number }>) {
    const k = r.category ?? "uncategorized";
    (typical.get(k) === undefined ? typical.set(k, 0) : null);
  }
  const medians = new Map<string, number>();
  for (const k of typical.keys()) {
    const xs = (db.prepare(`SELECT ABS(amount) AS a FROM transactions WHERE status='BOOK' AND is_internal=0 AND amount<0 AND booking_date >= ? AND booking_date < ? AND COALESCE(category,'uncategorized') = ? ORDER BY a`).all(daysAgo(180), from, k) as Array<{ a: number }>).map((r) => r.a);
    if (xs.length >= 5) medians.set(k, xs[Math.floor(xs.length / 2)]!);
  }
  for (const t of period) {
    const med = medians.get(t.category ?? "uncategorized");
    if (med && Math.abs(t.amount) > Math.max(1000, med * 3)) {
      out.push({ kind: "large", title: `Unusually large: ${t.counterparty ?? t.description}`, detail: `${Math.abs(t.amount).toFixed(0)} kr — typical for this category is ${med.toFixed(0)} kr.`, amount: t.amount, date: t.booking_date, transactionId: t.id });
    }
  }

  // New merchants over 500 kr.
  const seenBefore = new Set((db.prepare(`SELECT DISTINCT lower(trim(counterparty)) AS c FROM transactions WHERE booking_date < ? AND counterparty IS NOT NULL`).all(from) as Array<{ c: string }>).map((r) => r.c));
  const newSeen = new Set<string>();
  for (const t of period) {
    const c = t.counterparty?.trim().toLowerCase();
    if (!c || seenBefore.has(c) || newSeen.has(c) || Math.abs(t.amount) < 500) continue;
    newSeen.add(c);
    out.push({ kind: "new_merchant", title: `New: ${t.counterparty}`, detail: `First payment to this merchant: ${Math.abs(t.amount).toFixed(0)} kr on ${t.booking_date}.`, amount: t.amount, date: t.booking_date, transactionId: t.id });
  }

  return out.sort((a, b) => a.amount - b.amount);
}

// ---------------------------------------------------------------------------
// This month: where it closes, the big spends, the savings-rate gap
// ---------------------------------------------------------------------------

const FIXED_CATEGORIES = new Set(["housing", "utilities", "insurance", "kids", "subscriptions", "tax", "charity", "savings", "household_contribution"]);
const LUMPY_THRESHOLD = 10_000;

export interface MonthClose {
  scope: Scope;
  month: string;
  day: number;
  daysInMonth: number;
  daysLeft: number;
  income: { soFar: number; windfallSoFar: number; expected: Array<{ label: string; amount: number; date: string }>; expectedTotal: number; projected: number };
  spend: {
    soFar: number; // positive
    fixedSoFar: number;
    variableSoFar: number;
    expectedFixed: Array<{ label: string; amount: number; date: string }>;
    expectedFixedTotal: number;
    baselineDaily: number; // positive
    expectedVariable: number;
    projected: number;
  };
  projectedClose: number;
  projectedRate: number | null;
  typical: { income: number; expenses: number; rate: number | null; windowMonths: number };
  target: { rate: number; cutNeededMonthly: number };
  levers: Array<{ title: string; detail: string; monthlyImpact: number; cumulative: number; category?: string }>;
  bigSpends: Array<{ date: string; who: string; amount: number; category: string | null; categoryName: string; fixed: boolean }>;
  lumpy: Array<{ date: string; who: string; amount: number; category: string | null; categoryName: string }>;
  lumpyMonthlyReserve: number;
}

export function monthClose(currency = "DKK", owner: Scope = undefined): MonthClose {
  const sc = scopeSql(owner);
  const now = new Date();
  const month = monthKey(today());
  const start = `${month}-01`;
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const day = now.getUTCDate();
  const daysLeft = daysInMonth - day;
  const monthEnd = `${month}-${String(daysInMonth).padStart(2, "0")}`;
  const cats = listCategories();
  const kind = new Map(cats.map((c) => [c.id, c.kind]));
  const names = new Map(cats.map((c) => [c.id, c.name]));
  const nameOf = (c: string | null) => (c ? names.get(c) ?? c : "Uncategorized");

  const rows = db
    .prepare(
      `SELECT t.amount, ${sc.categoryExpr} AS cat, t.recurring_id, t.booking_date,
              COALESCE(NULLIF(trim(t.counterparty), ''), substr(t.description, 1, 40)) AS who
       FROM transactions t JOIN accounts a ON a.uid = t.account_uid
       WHERE t.status = 'BOOK' AND t.currency = ? AND t.booking_date >= ? AND ${sc.where} ORDER BY t.amount`,
    )
    .all(currency, start, ...sc.params) as Array<{ amount: number; cat: string; category: string | null; recurring_id: string | null; booking_date: string; who: string }>;
  for (const r of rows) r.category = r.cat === "uncategorized" ? null : r.cat;
  const ownerOf = new Map(listAccounts().map((a) => [a.uid, a.owner]));

  let incomeSoFar = 0, windfallSoFar = 0, spentSoFar = 0, fixedSoFar = 0;
  for (const r of rows) {
    const k = r.category ? kind.get(r.category) : undefined;
    const isIncome = k === "income" || (!r.category && r.amount > 0);
    if (isIncome) {
      if (r.category === "windfall") windfallSoFar += r.amount;
      else incomeSoFar += r.amount;
      continue;
    }
    spentSoFar -= r.amount; // refunds (positive in an expense category) reduce spend
    if (r.amount < 0 && (r.recurring_id || (r.category && FIXED_CATEGORIES.has(r.category)))) fixedSoFar -= r.amount;
  }

  // Recurring items still due this month.
  const expectedIncome: MonthClose["income"]["expected"] = [];
  const expectedFixed: MonthClose["spend"]["expectedFixed"] = [];
  for (const r of listRecurring({ activeOnly: true })) {
    if (owner && ownerOf.get(r.account_uid) !== owner) continue;
    let d = r.next_date;
    while (d <= monthEnd) {
      if (d > today()) (r.avg_amount > 0 ? expectedIncome : expectedFixed).push({ label: r.label, amount: r.avg_amount, date: d });
      d = isoDay(new Date(Date.parse(d) + r.interval_days * dayMs));
    }
  }

  // Cross-scope contributions are internal transfers, so recurring detection
  // skips them. Expect this month's usual contribution if it hasn't gone yet.
  if (owner) {
    const contrib = db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN t.booking_date >= ? AND t.amount < 0 THEN t.amount ELSE 0 END), 0) AS out_this_month,
                COALESCE(SUM(CASE WHEN t.booking_date >= ? AND t.amount > 0 THEN t.amount ELSE 0 END), 0) AS in_this_month,
                COALESCE(SUM(CASE WHEN t.booking_date < ? AND t.amount < 0 THEN t.amount ELSE 0 END), 0) AS out_before,
                COALESCE(SUM(CASE WHEN t.booking_date < ? AND t.amount > 0 THEN t.amount ELSE 0 END), 0) AS in_before
         FROM transactions t JOIN accounts a ON a.uid = t.account_uid
         WHERE t.status = 'BOOK' AND t.is_internal = 1 AND t.currency = ? AND t.booking_date >= ? AND ${sc.where}`,
      )
      .get(start, start, start, start, currency, daysAgo(92), ...sc.params) as { out_this_month: number; in_this_month: number; out_before: number; in_before: number };
    const monthsBefore = Math.max(1, Math.round((Date.parse(start) - Date.parse(daysAgo(92))) / (30.44 * dayMs)));
    const usualOut = contrib.out_before / monthsBefore; // negative
    const usualIn = contrib.in_before / monthsBefore; // positive
    const remainingOut = Math.min(0, usualOut - contrib.out_this_month);
    const remainingIn = Math.max(0, usualIn - contrib.in_this_month);
    if (remainingOut < -100) expectedFixed.push({ label: owner === "personal" ? "Contribution to shared accounts (usual)" : "Reimbursements to partners (usual)", amount: remainingOut, date: monthEnd });
    if (remainingIn > 100) expectedIncome.push({ label: owner === "personal" ? "Reimbursed from shared accounts (usual)" : "Partner contributions (usual)", amount: remainingIn, date: monthEnd });
  }
  // Irregular income (rental payouts, refunds) at its usual pace for the rest of the month.
  const firstDate = (db.prepare(`SELECT MIN(booking_date) AS d FROM transactions WHERE status = 'BOOK'`).get() as { d: string | null }).d;
  const dataDays = Math.max(30, Math.min(180, firstDate ? Math.round((Date.parse(today()) - Date.parse(firstDate)) / dayMs) : 90));
  const otherIncome = db
    .prepare(
      `SELECT COALESCE(SUM(t.amount), 0) AS total FROM transactions t JOIN categories c ON c.id = t.category JOIN accounts a ON a.uid = t.account_uid
       WHERE t.status = 'BOOK' AND t.is_internal = 0 AND t.recurring_id IS NULL AND c.kind = 'income' AND t.category <> 'windfall'
         AND t.currency = ? AND t.booking_date >= ? AND t.booking_date < ? ${owner ? "AND a.owner = ?" : ""}`,
    )
    .get(currency, daysAgo(Math.min(dataDays, 90)), today(), ...(owner ? [owner] : [])) as { total: number };
  const otherIncomeDaily = otherIncome.total / Math.min(dataDays, 90);
  if (otherIncomeDaily * daysLeft > 100) expectedIncome.push({ label: "Other income at its usual pace (rental etc.)", amount: otherIncomeDaily * daysLeft, date: monthEnd });

  const expectedIncomeTotal = expectedIncome.reduce((s, e) => s + e.amount, 0);
  const expectedFixedTotal = -expectedFixed.reduce((s, e) => s + e.amount, 0);

  // Everyday spending: last 90 days of outflows that are neither recurring nor lumpy.
  const base = db
    .prepare(
      `SELECT COALESCE(-SUM(t.amount), 0) AS total FROM transactions t JOIN accounts a ON a.uid = t.account_uid
       WHERE t.status = 'BOOK' AND t.is_internal = 0 AND t.recurring_id IS NULL AND t.amount < 0 AND t.amount > ? AND t.currency = ?
         AND t.booking_date >= ? AND t.booking_date < ? ${owner ? "AND a.owner = ?" : ""}`,
    )
    .get(-LUMPY_THRESHOLD, currency, daysAgo(90), today(), ...(owner ? [owner] : [])) as { total: number };
  const baselineDaily = base.total / 90;
  const expectedVariable = baselineDaily * daysLeft;

  const lumpyRows = db
    .prepare(
      `SELECT t.booking_date AS date, t.amount, t.category, COALESCE(NULLIF(trim(t.counterparty), ''), substr(t.description, 1, 40)) AS who
       FROM transactions t JOIN accounts a ON a.uid = t.account_uid
       WHERE t.status = 'BOOK' AND t.is_internal = 0 AND t.amount <= ? AND t.currency = ? AND t.booking_date >= ? ${owner ? "AND a.owner = ?" : ""} ORDER BY t.amount`,
    )
    .all(-LUMPY_THRESHOLD, currency, daysAgo(180), ...(owner ? [owner] : [])) as Array<{ date: string; amount: number; category: string | null; who: string }>;
  const lumpy = lumpyRows.map((l) => ({ ...l, categoryName: nameOf(l.category) }));
  // Spread over the months we actually have data for (capped at 6), so a
  // quarterly bill seen once in three months of history reserves a third.
  const lumpyMonths = Math.max(1, Math.min(6, dataDays / 30.44));
  const lumpyMonthlyReserve = -lumpy.reduce((s, l) => s + l.amount, 0) / lumpyMonths;

  const projectedIncome = incomeSoFar + expectedIncomeTotal;
  const projectedSpend = spentSoFar + expectedFixedTotal + expectedVariable;
  const projectedClose = projectedIncome - projectedSpend;

  const overview = spendingOverview(3, owner);
  const typicalRate = overview.monthlyAvgIncome > 0 ? 1 - overview.monthlyAvgExpenses / overview.monthlyAvgIncome : null;
  const targetRate = Number(getSetting("target_savings_rate", "0.35"));
  const cutNeededMonthly = Math.max(0, overview.monthlyAvgExpenses - (1 - targetRate) * overview.monthlyAvgIncome);

  const seen = new Set<string>();
  let cumulative = 0;
  const levers = overview.opportunities
    .filter((o) => o.kind !== "price_increase" && (seen.has(o.title) ? false : (seen.add(o.title), true)))
    .slice(0, 8)
    .map((o) => {
      const monthlyImpact = o.yearlyImpact / 12;
      cumulative += monthlyImpact;
      return { title: o.title, detail: o.detail, monthlyImpact, cumulative, category: o.category };
    });

  const bigSpends = rows
    .filter((r) => r.amount < 0 && kind.get(r.category ?? "") !== "income")
    .slice(0, 8)
    .map((r) => ({
      date: r.booking_date,
      who: r.who,
      amount: r.amount,
      category: r.category,
      categoryName: nameOf(r.category),
      fixed: Boolean(r.recurring_id || (r.category && FIXED_CATEGORIES.has(r.category))),
    }));

  return {
    scope: owner,
    month, day, daysInMonth, daysLeft,
    income: { soFar: incomeSoFar, windfallSoFar, expected: expectedIncome, expectedTotal: expectedIncomeTotal, projected: projectedIncome },
    spend: { soFar: spentSoFar, fixedSoFar, variableSoFar: spentSoFar - fixedSoFar, expectedFixed, expectedFixedTotal, baselineDaily, expectedVariable, projected: projectedSpend },
    projectedClose,
    projectedRate: projectedIncome > 0 ? projectedClose / projectedIncome : null,
    typical: { income: overview.monthlyAvgIncome, expenses: overview.monthlyAvgExpenses, rate: typicalRate, windowMonths: overview.windowMonths },
    target: { rate: targetRate, cutNeededMonthly },
    levers,
    bigSpends,
    lumpy,
    lumpyMonthlyReserve,
  };
}
