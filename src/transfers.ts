import { randomUUID } from "node:crypto";
import { db } from "./db.ts";

interface Candidate {
  id: string;
  account_uid: string;
  amount: number;
  currency: string;
  date: string;
  text: string;
}

const dayMs = 86_400_000;

/** Lower-cased name tokens (>= 3 chars) of each account's holder(s), for tie-breaking. */
function holderTokens(): Map<string, string[]> {
  const rows = db.prepare(`SELECT uid, COALESCE(name, '') AS name FROM accounts`).all() as Array<{ uid: string; name: string }>;
  return new Map(rows.map((r) => [r.uid, r.name.toLowerCase().split(/[^a-zæøå]+/).filter((t) => t.length >= 3)]));
}

/**
 * Money moving between two of our own accounts shows up twice: once out, once
 * in. Pair them up (same amount, opposite sign, different account, within a
 * few days) and mark both sides internal so they never count as income or
 * spending. Runs incrementally; already-paired rows are left alone.
 */
export function detectInternalTransfers(maxGapDays = 3): number {
  const rows = db
    .prepare(
      `SELECT id, account_uid, amount, currency, COALESCE(booking_date, value_date, transaction_date) AS date,
              lower(COALESCE(counterparty, '') || ' ' || COALESCE(description, '')) AS text
       FROM transactions
       WHERE is_internal = 0 AND status = 'BOOK' AND date IS NOT NULL AND (category_source IS NULL OR category_source <> 'manual')
       ORDER BY date`,
    )
    .all() as unknown as Candidate[];
  const holders = holderTokens();

  // Index inflows by "currency:amount" so each outflow only scans its own bucket.
  const inflows = new Map<string, Candidate[]>();
  for (const r of rows) {
    if (r.amount <= 0) continue;
    const key = `${r.currency}:${r.amount.toFixed(2)}`;
    (inflows.get(key) ?? inflows.set(key, []).get(key)!).push(r);
  }

  const used = new Set<string>();
  const pairs: Array<[Candidate, Candidate]> = [];
  for (const out of rows) {
    if (out.amount >= 0) continue;
    const bucket = inflows.get(`${out.currency}:${(-out.amount).toFixed(2)}`);
    if (!bucket) continue;
    const outTime = Date.parse(out.date);
    let best: Candidate | undefined;
    let bestScore = Infinity;
    for (const inn of bucket) {
      if (used.has(inn.id) || inn.account_uid === out.account_uid) continue;
      const gap = Math.abs(Date.parse(inn.date) - outTime) / dayMs;
      if (gap > maxGapDays) continue;
      // Several equal amounts can land the same day (two people each putting
      // 10,000 into a joint account). Prefer the inflow whose text names the
      // holder of the account the money left, and vice versa.
      const outHolder = holders.get(out.account_uid) ?? [];
      const inHolder = holders.get(inn.account_uid) ?? [];
      const nameMatch = outHolder.some((t) => inn.text.includes(t)) || inHolder.some((t) => out.text.includes(t));
      const score = gap - (nameMatch ? 10 : 0);
      if (score < bestScore) {
        best = inn;
        bestScore = score;
      }
    }
    if (best) {
      used.add(best.id);
      used.add(out.id);
      pairs.push([out, best]);
    }
  }

  const mark = db.prepare(`UPDATE transactions SET is_internal = 1, transfer_group = ?, category = 'internal', category_source = 'transfer' WHERE id = ?`);
  db.exec("BEGIN");
  try {
    for (const [a, b] of pairs) {
      const group = randomUUID();
      mark.run(group, a.id);
      mark.run(group, b.id);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return pairs.length;
}

/** Undo an internal mark (e.g. a coincidental amount match). */
export function unmarkInternal(txId: string): void {
  const row = db.prepare(`SELECT transfer_group FROM transactions WHERE id = ?`).get(txId) as { transfer_group: string | null } | undefined;
  if (!row) return;
  const stmt = db.prepare(`UPDATE transactions SET is_internal = 0, transfer_group = NULL, category = NULL, category_source = NULL WHERE ${row.transfer_group ? "transfer_group = ?" : "id = ?"}`);
  stmt.run(row.transfer_group ?? txId);
}
