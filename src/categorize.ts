import { db } from "./db.ts";
import { DEFAULT_CATEGORIES, DEFAULT_RULES, type Category } from "./categories.ts";

export interface Rule {
  id: number;
  pattern: string;
  category: string;
  priority: number;
  source: string;
}

export function seedCategories(): void {
  const insertCat = db.prepare(`INSERT INTO categories (id, name, kind, sort) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, sort = excluded.sort`);
  for (const c of DEFAULT_CATEGORIES) insertCat.run(c.id, c.name, c.kind, c.sort);

  // Add default rules that are new since the last run; never touch user or AI rules.
  const insertRule = db.prepare(
    `INSERT INTO category_rules (pattern, category, priority, source)
     SELECT ?, ?, 100, 'default' WHERE NOT EXISTS (SELECT 1 FROM category_rules WHERE pattern = ? AND source = 'default')`,
  );
  for (const [pattern, category] of DEFAULT_RULES) insertRule.run(pattern, category, pattern);
  // Defaults whose category moved (e.g. "skat" from fees to tax) follow the code.
  const fix = db.prepare(`UPDATE category_rules SET category = ? WHERE pattern = ? AND source = 'default' AND category <> ?`);
  for (const [pattern, category] of DEFAULT_RULES) fix.run(category, pattern, category);
}

export function listCategories(): Category[] {
  return db.prepare(`SELECT id, name, kind, sort FROM categories ORDER BY sort, name`).all() as unknown as Category[];
}

export function categoryKinds(): Map<string, Category["kind"]> {
  return new Map(listCategories().map((c) => [c.id, c.kind]));
}

export function listRules(): Rule[] {
  return db.prepare(`SELECT id, pattern, category, priority, source FROM category_rules ORDER BY priority ASC, length(pattern) DESC, id ASC`).all() as unknown as Rule[];
}

export function addRule(pattern: string, category: string, source: "user" | "ai" = "user"): Rule {
  const priority = source === "user" ? 10 : 50;
  const res = db.prepare(`INSERT INTO category_rules (pattern, category, priority, source) VALUES (?, ?, ?, ?)`).run(pattern.trim().toLowerCase(), category, priority, source);
  return { id: Number(res.lastInsertRowid), pattern: pattern.trim().toLowerCase(), category, priority, source };
}

export function deleteRule(id: number): void {
  db.prepare(`DELETE FROM category_rules WHERE id = ?`).run(id);
}

export function searchText(t: { counterparty: string | null; description: string | null }): string {
  return `${t.counterparty ?? ""} ${t.description ?? ""}`.toLowerCase();
}

/**
 * First matching rule wins (user rules before AI rules before defaults; longer
 * patterns before shorter). Income categories never apply to money going out.
 */
export function matchRule(text: string, amount: number, rules: Rule[], kinds: Map<string, Category["kind"]>): Rule | undefined {
  for (const r of rules) {
    if (!text.includes(r.pattern)) continue;
    if (kinds.get(r.category) === "income" && amount < 0) continue;
    return r;
  }
  return undefined;
}

interface TxLite {
  id: string;
  amount: number;
  counterparty: string | null;
  description: string | null;
}

/**
 * Applies rules to transactions. By default only touches uncategorized ones so
 * manual choices survive; `force` re-evaluates everything not set manually
 * (used after a rule is added or removed).
 */
export function applyRules(opts: { force?: boolean } = {}): number {
  const rules = listRules();
  const kinds = categoryKinds();
  const rows = db
    .prepare(
      opts.force
        ? `SELECT id, amount, counterparty, description FROM transactions WHERE is_internal = 0 AND (category_source IS NULL OR category_source IN ('rule','ai'))`
        : `SELECT id, amount, counterparty, description FROM transactions WHERE is_internal = 0 AND category IS NULL`,
    )
    .all() as unknown as TxLite[];

  const update = db.prepare(`UPDATE transactions SET category = ?, category_source = ? WHERE id = ?`);
  let n = 0;
  db.exec("BEGIN");
  try {
    for (const t of rows) {
      const rule = matchRule(searchText(t), t.amount, rules, kinds);
      if (rule) {
        update.run(rule.category, rule.source === "ai" ? "ai" : "rule", t.id);
        n++;
      } else if (opts.force) {
        update.run(null, null, t.id);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return n;
}

export function setCategory(txId: string, category: string | null): void {
  db.prepare(`UPDATE transactions SET category = ?, category_source = ? WHERE id = ?`).run(category, category ? "manual" : null, txId);
}

/** Distinct merchant keys that still have no category, most frequent first. */
export function uncategorizedMerchants(limit = 150): Array<{ key: string; count: number; total: number; sample: string }> {
  return db
    .prepare(
      `
      SELECT COALESCE(NULLIF(trim(counterparty), ''), substr(COALESCE(description, ''), 1, 40)) AS key,
             COUNT(*) AS count, SUM(amount) AS total,
             MAX(COALESCE(counterparty, '') || ' | ' || COALESCE(description, '')) AS sample
      FROM transactions
      WHERE is_internal = 0 AND category IS NULL AND status = 'BOOK'
      GROUP BY key HAVING key <> ''
      ORDER BY count DESC, ABS(total) DESC
      LIMIT ?
    `,
    )
    .all(limit) as unknown as Array<{ key: string; count: number; total: number; sample: string }>;
}

/**
 * Asks Claude to categorize the merchants rules could not. Each answer is
 * stored as an AI rule so future transactions from the same merchant match
 * without another call. Silently skipped when no API credentials are present.
 */
export async function categorizeWithAI(limit = 150): Promise<{ merchants: number; applied: number; skipped?: string }> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return { merchants: 0, applied: 0, skipped: "no ANTHROPIC_API_KEY in .env" };
  }
  const merchants = uncategorizedMerchants(limit);
  if (!merchants.length) return { merchants: 0, applied: 0 };

  const [{ default: Anthropic }, { z }, { zodOutputFormat }] = await Promise.all([
    import("@anthropic-ai/sdk"),
    import("zod"),
    import("@anthropic-ai/sdk/helpers/zod"),
  ]);
  const client = new Anthropic();
  const categories = listCategories().filter((c) => c.kind !== "transfer");
  const ids = categories.map((c) => c.id) as [string, ...string[]];

  const Schema = z.object({
    assignments: z.array(z.object({ key: z.string(), category: z.enum(ids) })),
  });

  const response = await client.messages.parse({
    model: "claude-opus-5",
    max_tokens: 16000,
    system: `You categorize Danish personal bank transactions into a fixed chart of accounts.
Categories (id: description): ${categories.map((c) => `${c.id}: ${c.name}`).join("; ")}.
Rules: "p2p" is MobilePay or transfers to private people. "card_settlement" is only for payments to a credit card. Use "other" when genuinely unsure.
Positive totals are money coming in; negative are money going out. Return one assignment per key, using the key exactly as given.`,
    messages: [
      {
        role: "user",
        content: merchants
          .map((m) => `key: ${JSON.stringify(m.key)} | seen ${m.count}x | net ${m.total.toFixed(0)} DKK | sample: ${m.sample.slice(0, 120)}`)
          .join("\n"),
      },
    ],
    output_config: { format: zodOutputFormat(Schema) },
  });

  const parsed = response.parsed_output;
  if (!parsed) return { merchants: merchants.length, applied: 0, skipped: "model returned no parseable output" };

  let applied = 0;
  const kinds = categoryKinds();
  const update = db.prepare(
    `UPDATE transactions SET category = ?, category_source = 'ai'
     WHERE is_internal = 0 AND category IS NULL
       AND COALESCE(NULLIF(trim(counterparty), ''), substr(COALESCE(description, ''), 1, 40)) = ?`,
  );
  const validKeys = new Set(merchants.map((m) => m.key));
  for (const a of parsed.assignments) {
    if (!validKeys.has(a.key)) continue;
    const res = update.run(a.category, a.key);
    applied += Number(res.changes);
    // Only make a rule when the key is a real merchant name, not a description fragment.
    if (a.key.length >= 4 && kinds.has(a.category)) addRule(a.key.toLowerCase(), a.category, "ai");
  }
  return { merchants: merchants.length, applied };
}
