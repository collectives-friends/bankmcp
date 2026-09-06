import { createHash } from "node:crypto";
import { db } from "./db.ts";

interface TxLite {
  id: string;
  account_uid: string;
  amount: number;
  date: string;
  counterparty: string | null;
  description: string | null;
  category: string | null;
}

export interface RecurringRow {
  id: string;
  account_uid: string;
  account_name: string | null;
  key: string;
  label: string;
  category: string | null;
  cadence: string;
  interval_days: number;
  avg_amount: number;
  last_amount: number;
  occurrences: number;
  first_date: string;
  last_date: string;
  next_date: string;
  active: number;
  yearly_amount: number;
}

const CADENCES: Array<{ name: string; min: number; max: number; days: number }> = [
  { name: "weekly", min: 5, max: 9, days: 7 },
  { name: "biweekly", min: 12, max: 16, days: 14 },
  { name: "monthly", min: 26, max: 35, days: 30.44 },
  { name: "quarterly", min: 80, max: 100, days: 91.3 },
  { name: "yearly", min: 340, max: 390, days: 365.25 },
];

/** Collapses a merchant string to something stable across transactions. */
export function merchantKey(t: { counterparty: string | null; description: string | null }): string {
  const raw = (t.counterparty?.trim() || t.description?.trim() || "").toLowerCase();
  return raw
    .replace(/[0-9]+/g, " ")
    .replace(/[^a-zæøåäöü&\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 3)
    .join(" ");
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Finds merchants that hit an account on a regular rhythm with a stable
 * amount: rent, subscriptions, salary, insurance. Rebuilt from scratch every
 * run — it's cheap and avoids drift.
 */
export function detectRecurring(): number {
  const rows = db
    .prepare(
      `SELECT id, account_uid, amount, COALESCE(booking_date, value_date) AS date, counterparty, description, category
       FROM transactions WHERE status = 'BOOK' AND is_internal = 0 AND date IS NOT NULL ORDER BY date`,
    )
    .all() as unknown as TxLite[];

  const groups = new Map<string, TxLite[]>();
  for (const t of rows) {
    const key = merchantKey(t);
    if (key.length < 3) continue;
    const gk = `${t.account_uid}|${key}|${t.amount < 0 ? "out" : "in"}`;
    (groups.get(gk) ?? groups.set(gk, []).get(gk)!).push(t);
  }

  const today = new Date().toISOString().slice(0, 10);
  const found: Array<{ row: Omit<RecurringRow, "account_name" | "yearly_amount">; ids: string[] }> = [];

  for (const [gk, txs] of groups) {
    if (txs.length < 3) continue;
    // One transaction per day per merchant; multiple same-day hits are one event.
    const byDay = new Map<string, number>();
    for (const t of txs) byDay.set(t.date, (byDay.get(t.date) ?? 0) + t.amount);
    const dates = [...byDay.keys()].sort();
    if (dates.length < 3) continue;

    const gaps = dates.slice(1).map((d, i) => (Date.parse(d) - Date.parse(dates[i]!)) / 86_400_000);
    const gap = median(gaps);
    const cadence = CADENCES.find((c) => gap >= c.min && gap <= c.max);
    if (!cadence) continue;
    const regular = gaps.filter((g) => Math.abs(g - gap) <= Math.max(3, gap * 0.35)).length / gaps.length;
    if (regular < 0.7) continue;

    const amounts = dates.map((d) => byDay.get(d)!);
    const avg = amounts.reduce((s, a) => s + a, 0) / amounts.length;
    const sd = Math.sqrt(amounts.reduce((s, a) => s + (a - avg) ** 2, 0) / amounts.length);
    if (Math.abs(avg) < 20 || sd / Math.abs(avg) > 0.3) continue;

    const [account_uid, key] = gk.split("|") as [string, string, string];
    const last = txs[txs.length - 1]!;
    const lastDate = dates[dates.length - 1]!;
    const nextDate = addDays(lastDate, cadence.days);
    const active = (Date.parse(today) - Date.parse(lastDate)) / 86_400_000 <= cadence.days * 2 ? 1 : 0;
    const category = txs.map((t) => t.category).filter(Boolean).sort((a, b) => txs.filter((t) => t.category === b).length - txs.filter((t) => t.category === a).length)[0] ?? null;

    found.push({
      row: {
        id: createHash("sha1").update(gk).digest("hex").slice(0, 16),
        account_uid,
        key,
        label: last.counterparty?.trim() || last.description?.trim()?.slice(0, 60) || key,
        category,
        cadence: cadence.name,
        interval_days: cadence.days,
        avg_amount: avg,
        last_amount: amounts[amounts.length - 1]!,
        occurrences: dates.length,
        first_date: dates[0]!,
        last_date: lastDate,
        next_date: nextDate,
        active,
      },
      ids: txs.map((t) => t.id),
    });
  }

  const upsert = db.prepare(`
    INSERT INTO recurring (id, account_uid, key, label, category, cadence, interval_days, avg_amount, last_amount, occurrences, first_date, last_date, next_date, active, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(id) DO UPDATE SET label = excluded.label, category = excluded.category, cadence = excluded.cadence,
      interval_days = excluded.interval_days, avg_amount = excluded.avg_amount, last_amount = excluded.last_amount,
      occurrences = excluded.occurrences, first_date = excluded.first_date, last_date = excluded.last_date,
      next_date = excluded.next_date, active = excluded.active, updated_at = excluded.updated_at
  `);
  const tag = db.prepare(`UPDATE transactions SET recurring_id = ? WHERE id = ?`);

  db.exec("BEGIN");
  try {
    db.exec(`UPDATE transactions SET recurring_id = NULL`);
    const keep = found.map((f) => `'${f.row.id}'`).join(",");
    db.exec(`DELETE FROM recurring${keep ? ` WHERE id NOT IN (${keep})` : ""}`);
    for (const f of found) {
      const r = f.row;
      upsert.run(r.id, r.account_uid, r.key, r.label, r.category, r.cadence, r.interval_days, r.avg_amount, r.last_amount, r.occurrences, r.first_date, r.last_date, r.next_date, r.active);
      for (const id of f.ids) tag.run(r.id, id);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return found.length;
}

export function listRecurring(opts: { activeOnly?: boolean } = {}): RecurringRow[] {
  return db
    .prepare(
      `SELECT r.*, COALESCE(a.display_name, a.name) AS account_name,
              r.avg_amount * (365.25 / r.interval_days) AS yearly_amount
       FROM recurring r JOIN accounts a ON a.uid = r.account_uid
       ${opts.activeOnly ? "WHERE r.active = 1" : ""}
       ORDER BY r.active DESC, ABS(yearly_amount) DESC`,
    )
    .all() as unknown as RecurringRow[];
}
