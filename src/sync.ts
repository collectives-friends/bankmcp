import { config } from "./config.ts";
import { eb, EnableBankingError } from "./enablebanking.ts";
import * as store from "./db.ts";
import { postProcess, type PipelineResult } from "./pipeline.ts";

export interface SyncResult {
  accountUid: string;
  name: string | null;
  transactions: number;
  error?: string;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

/**
 * Pulls balances and new transactions for one account. On the first sync we
 * go back EB_HISTORY_DAYS; afterwards we re-fetch from a few days before the
 * last booked transaction so pending entries get updated once they settle.
 */
export async function syncAccount(accountUid: string, name: string | null): Promise<SyncResult> {
  try {
    store.saveBalances(accountUid, await eb.getBalances(accountUid));

    const latest = store.latestBookingDate(accountUid);
    const from = latest ? new Date(new Date(latest).getTime() - 5 * 86_400_000) : daysAgo(config.historyDays);
    const transactions = await eb.getTransactions(accountUid, { dateFrom: isoDate(from), dateTo: isoDate(new Date()) });
    const count = store.saveTransactions(accountUid, transactions);
    store.markSynced(accountUid);
    return { accountUid, name, transactions: count };
  } catch (err) {
    const message = err instanceof EnableBankingError ? `${err.status}: ${err.body.slice(0, 300)}` : String(err);
    return { accountUid, name, transactions: 0, error: message };
  }
}

/** Syncs every account we know about, then runs the ledger pipeline. */
export async function syncAll(): Promise<{ results: SyncResult[]; pipeline: PipelineResult }> {
  const results: SyncResult[] = [];
  for (const account of store.listAccounts()) {
    if (account.session_status !== "AUTHORIZED") continue;
    results.push(await syncAccount(account.uid, account.name));
  }
  await refreshSessionStatuses();
  const pipeline = await postProcess();
  return { results, pipeline };
}

/** Asks Enable Banking whether each consent is still alive. */
export async function refreshSessionStatuses(): Promise<void> {
  for (const s of store.listSessions()) {
    try {
      const remote = await eb.getSession(s.id);
      if (remote.status !== s.status) store.setSessionStatus(s.id, remote.status);
    } catch (err) {
      if (err instanceof EnableBankingError && err.status === 404) store.setSessionStatus(s.id, "CLOSED");
    }
  }
}
