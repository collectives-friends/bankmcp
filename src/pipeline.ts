import { db, inferAccountDefaults } from "./db.ts";
import { applyRules, categorizeWithAI, seedCategories } from "./categorize.ts";
import { detectInternalTransfers } from "./transfers.ts";
import { detectRecurring } from "./recurring.ts";
import { backfillSnapshots, snapshotBalances } from "./analytics.ts";

export interface PipelineResult {
  internalPairs: number;
  ruleCategorized: number;
  ai: { merchants: number; applied: number; skipped?: string };
  recurring: number;
  snapshots: number;
  backfilled: number;
}

/**
 * Everything that turns raw bank rows into a ledger. Order matters: transfers
 * are netted before categorization so a transfer never becomes "spending",
 * and recurring detection runs on categorized rows so items inherit a category.
 */
export async function postProcess(opts: { ai?: boolean; reset?: boolean } = {}): Promise<PipelineResult> {
  seedCategories();
  inferAccountDefaults();
  if (opts.reset) {
    // Re-derive everything except what the user set by hand.
    db.exec(`UPDATE transactions SET is_internal = 0, transfer_group = NULL, category = NULL, category_source = NULL
             WHERE category_source IS NULL OR category_source <> 'manual'`);
  }
  const internalPairs = detectInternalTransfers();
  const ruleCategorized = applyRules();
  const ai = opts.ai === false ? { merchants: 0, applied: 0, skipped: "disabled" } : await categorizeWithAI().catch((err: unknown) => ({ merchants: 0, applied: 0, skipped: `AI error: ${String(err).slice(0, 200)}` }));
  const recurring = detectRecurring();
  const snapshots = snapshotBalances();
  const backfilled = backfillSnapshots();
  return { internalPairs, ruleCategorized, ai, recurring, snapshots, backfilled };
}
