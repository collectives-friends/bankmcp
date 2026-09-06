import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import type { AccountResource, Balance, Session, Transaction } from "./enablebanking.ts";

mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS sessions (
    id            TEXT PRIMARY KEY,
    aspsp_name    TEXT NOT NULL,
    aspsp_country TEXT NOT NULL,
    psu_type      TEXT NOT NULL,
    valid_until   TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'AUTHORIZED',
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS accounts (
    uid                 TEXT PRIMARY KEY,
    session_id          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    name                TEXT,
    iban                TEXT,
    other_id            TEXT,
    currency            TEXT NOT NULL,
    product             TEXT,
    cash_account_type   TEXT,
    identification_hash TEXT NOT NULL,
    last_synced_at      TEXT,
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS balances (
    account_uid    TEXT NOT NULL REFERENCES accounts(uid) ON DELETE CASCADE,
    balance_type   TEXT NOT NULL,
    name           TEXT,
    amount         REAL NOT NULL,
    currency       TEXT NOT NULL,
    reference_date TEXT,
    updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (account_uid, balance_type)
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id               TEXT PRIMARY KEY,
    account_uid      TEXT NOT NULL REFERENCES accounts(uid) ON DELETE CASCADE,
    amount           REAL NOT NULL,   -- signed: negative = money out
    currency         TEXT NOT NULL,
    status           TEXT NOT NULL,
    booking_date     TEXT,
    value_date       TEXT,
    transaction_date TEXT,
    counterparty     TEXT,
    description      TEXT,
    bank_code        TEXT,
    mcc              TEXT,
    raw              TEXT NOT NULL,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS transactions_account_date ON transactions(account_uid, booking_date DESC);
  CREATE INDEX IF NOT EXISTS transactions_date ON transactions(booking_date DESC);

  CREATE TABLE IF NOT EXISTS categories (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('income', 'expense', 'transfer')),
    sort INTEGER NOT NULL DEFAULT 100
  );

  CREATE TABLE IF NOT EXISTS category_rules (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern    TEXT NOT NULL,           -- case-insensitive substring of "counterparty description"
    category   TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    priority   INTEGER NOT NULL DEFAULT 100, -- lower wins; user rules default to 10, defaults to 100
    source     TEXT NOT NULL DEFAULT 'user',  -- user | default | ai
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS balance_snapshots (
    date        TEXT NOT NULL,
    account_uid TEXT NOT NULL REFERENCES accounts(uid) ON DELETE CASCADE,
    amount      REAL NOT NULL,
    currency    TEXT NOT NULL,
    source      TEXT NOT NULL DEFAULT 'sync', -- sync | backfill
    PRIMARY KEY (date, account_uid)
  );

  CREATE TABLE IF NOT EXISTS recurring (
    id            TEXT PRIMARY KEY,
    account_uid   TEXT NOT NULL REFERENCES accounts(uid) ON DELETE CASCADE,
    key           TEXT NOT NULL,
    label         TEXT NOT NULL,
    category      TEXT,
    cadence       TEXT NOT NULL,   -- weekly | biweekly | monthly | quarterly | yearly
    interval_days REAL NOT NULL,
    avg_amount    REAL NOT NULL,   -- signed
    last_amount   REAL NOT NULL,
    occurrences   INTEGER NOT NULL,
    first_date    TEXT NOT NULL,
    last_date     TEXT NOT NULL,
    next_date     TEXT NOT NULL,
    active        INTEGER NOT NULL DEFAULT 1,
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS budgets (
    category      TEXT PRIMARY KEY REFERENCES categories(id) ON DELETE CASCADE,
    monthly_limit REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS briefings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    period_start TEXT NOT NULL,
    period_end   TEXT NOT NULL,
    facts        TEXT NOT NULL,  -- JSON
    markdown     TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`);

db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

export function getSetting(key: string, fallback: string): string {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}
export function setSetting(key: string, value: string): void {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

// Columns added after the first release; ALTER TABLE is idempotent via the check.
function addColumn(table: string, column: string, ddl: string): void {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
addColumn("accounts", "kind", "TEXT NOT NULL DEFAULT 'asset'"); // asset | liability | credit_card
addColumn("accounts", "owner", "TEXT"); // e.g. personal | joint
addColumn("accounts", "display_name", "TEXT");
addColumn("accounts", "include_in_total", "INTEGER NOT NULL DEFAULT 1");
addColumn("transactions", "category", "TEXT");
addColumn("transactions", "category_source", "TEXT"); // rule | ai | manual | transfer
addColumn("transactions", "is_internal", "INTEGER NOT NULL DEFAULT 0");
addColumn("transactions", "transfer_group", "TEXT");
addColumn("transactions", "recurring_id", "TEXT");
db.exec(`CREATE INDEX IF NOT EXISTS transactions_category ON transactions(category)`);

// --- Sessions & accounts ---

const insertSession = db.prepare(`
  INSERT INTO sessions (id, aspsp_name, aspsp_country, psu_type, valid_until)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET valid_until = excluded.valid_until, status = 'AUTHORIZED'
`);

const insertAccount = db.prepare(`
  INSERT INTO accounts (uid, session_id, name, iban, other_id, currency, product, cash_account_type, identification_hash)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(uid) DO UPDATE SET
    session_id = excluded.session_id, name = excluded.name, iban = excluded.iban,
    other_id = excluded.other_id, product = excluded.product
`);

export function saveSession(session: Session): void {
  insertSession.run(session.session_id, session.aspsp.name, session.aspsp.country, session.psu_type, session.access.valid_until);
  for (const a of session.accounts) saveAccount(session.session_id, a);
}

function saveAccount(sessionId: string, a: AccountResource): void {
  insertAccount.run(
    a.uid,
    sessionId,
    a.name ?? a.product ?? null,
    a.account_id?.iban ?? null,
    a.account_id?.other?.identification ?? null,
    a.currency,
    a.product ?? null,
    a.cash_account_type ?? null,
    a.identification_hash,
  );
}

export function setSessionStatus(sessionId: string, status: string): void {
  db.prepare(`UPDATE sessions SET status = ? WHERE id = ?`).run(status, sessionId);
}

export function deleteSession(sessionId: string): void {
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
}

export interface AccountRow {
  uid: string;
  session_id: string;
  name: string | null;
  iban: string | null;
  other_id: string | null;
  currency: string;
  product: string | null;
  cash_account_type: string | null;
  kind: "asset" | "liability" | "credit_card";
  owner: string | null;
  display_name: string | null;
  include_in_total: number;
  last_synced_at: string | null;
  aspsp_name: string;
  aspsp_country: string;
  valid_until: string;
  session_status: string;
  balance: number | null;
  balance_type: string | null;
  balance_updated_at: string | null;
  available: number | null;
  transaction_count: number;
}

/**
 * Accounts joined with their balances. Banks report several balance types.
 * `balance` is the booked balance (what you actually have or owe — for a
 * mortgage that is the debt); `available` adds any credit line and is what
 * you could spend right now. Net worth must use the booked figure.
 */
export function listAccounts(): AccountRow[] {
  return db
    .prepare(
      `
      SELECT a.*, s.aspsp_name, s.aspsp_country, s.valid_until, s.status AS session_status,
             b.amount AS balance, b.balance_type, b.updated_at AS balance_updated_at,
             (SELECT amount FROM balances b3 WHERE b3.account_uid = a.uid AND b3.balance_type IN ('ITAV', 'CLAV')
              ORDER BY CASE balance_type WHEN 'ITAV' THEN 0 ELSE 1 END LIMIT 1) AS available,
             (SELECT COUNT(*) FROM transactions t WHERE t.account_uid = a.uid) AS transaction_count
      FROM accounts a
      JOIN sessions s ON s.id = a.session_id
      LEFT JOIN balances b ON b.account_uid = a.uid AND b.balance_type = (
        SELECT balance_type FROM balances b2 WHERE b2.account_uid = a.uid
        ORDER BY CASE balance_type
          WHEN 'ITBD' THEN 0 WHEN 'CLBD' THEN 1 WHEN 'XPCD' THEN 2 WHEN 'OPBD' THEN 3 WHEN 'ITAV' THEN 4 WHEN 'CLAV' THEN 5 ELSE 9 END
        LIMIT 1
      )
      ORDER BY s.aspsp_name, a.name
    `,
    )
    .all() as unknown as AccountRow[];
}

export function updateAccount(
  uid: string,
  patch: Partial<Pick<AccountRow, "kind" | "owner" | "display_name" | "include_in_total">>,
): void {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    params.push(v as string | number | null);
  }
  if (!sets.length) return;
  params.push(uid);
  db.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE uid = ?`).run(...params);
}

/**
 * First-time defaults for the fields the bank can't tell us: credit facilities
 * are liabilities, and accounts listing two holders are joint.
 */
export function inferAccountDefaults(): void {
  db.exec(`
    UPDATE accounts SET kind = 'liability'
      WHERE owner IS NULL AND (lower(coalesce(product,'')) LIKE '%kredit%' OR lower(coalesce(name,'')) LIKE '%kredit%' OR lower(coalesce(product,'')) LIKE '%lån%');
    UPDATE accounts SET owner = CASE WHEN name LIKE '%;%' OR name LIKE '%,%' THEN 'joint' ELSE 'personal' END
      WHERE owner IS NULL;
  `);
}

export function listSessions() {
  return db
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM accounts a WHERE a.session_id = s.id) AS account_count
       FROM sessions s ORDER BY created_at DESC`,
    )
    .all() as unknown as Array<{
    id: string;
    aspsp_name: string;
    aspsp_country: string;
    psu_type: string;
    valid_until: string;
    status: string;
    created_at: string;
    account_count: number;
  }>;
}

// --- Balances ---

const upsertBalance = db.prepare(`
  INSERT INTO balances (account_uid, balance_type, name, amount, currency, reference_date, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ON CONFLICT(account_uid, balance_type) DO UPDATE SET
    name = excluded.name, amount = excluded.amount, currency = excluded.currency,
    reference_date = excluded.reference_date, updated_at = excluded.updated_at
`);

export function saveBalances(accountUid: string, balances: Balance[]): void {
  for (const b of balances) {
    upsertBalance.run(accountUid, b.balance_type, b.name ?? null, Number(b.balance_amount.amount), b.balance_amount.currency, b.reference_date ?? null);
  }
}

// --- Transactions ---

const upsertTransaction = db.prepare(`
  INSERT INTO transactions (id, account_uid, amount, currency, status, booking_date, value_date, transaction_date,
                            counterparty, description, bank_code, mcc, raw)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    status = excluded.status, booking_date = excluded.booking_date, value_date = excluded.value_date,
    counterparty = excluded.counterparty, description = excluded.description, raw = excluded.raw
`);

/**
 * Banks don't always give a stable reference for a transaction, so fall back
 * to a hash of the fields that identify it. Pending entries can change id
 * once booked; the sync handles that by re-fetching a small overlap window.
 */
export function transactionId(accountUid: string, t: Transaction): string {
  const ref = t.entry_reference || t.transaction_id;
  if (ref) return `${accountUid}:${ref}`;
  const fingerprint = [
    t.booking_date ?? t.value_date ?? t.transaction_date ?? "",
    t.transaction_amount.amount,
    t.transaction_amount.currency,
    t.credit_debit_indicator,
    (t.remittance_information ?? []).join("|"),
    t.creditor?.name ?? "",
    t.debtor?.name ?? "",
  ].join(" ");
  return `${accountUid}:h:${createHash("sha256").update(fingerprint).digest("hex").slice(0, 32)}`;
}

export function saveTransactions(accountUid: string, transactions: Transaction[]): number {
  db.exec("BEGIN");
  try {
    for (const t of transactions) {
      const signed = Number(t.transaction_amount.amount) * (t.credit_debit_indicator === "DBIT" ? -1 : 1);
      const counterparty = (signed < 0 ? t.creditor?.name : t.debtor?.name) ?? t.creditor?.name ?? t.debtor?.name ?? null;
      const description = (t.remittance_information ?? []).filter(Boolean).join(" ") || t.note || null;
      upsertTransaction.run(
        transactionId(accountUid, t),
        accountUid,
        signed,
        t.transaction_amount.currency,
        t.status,
        t.booking_date ?? null,
        t.value_date ?? null,
        t.transaction_date ?? null,
        counterparty,
        description,
        t.bank_transaction_code?.description ?? t.bank_transaction_code?.code ?? null,
        t.merchant_category_code ?? null,
        JSON.stringify(t),
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return transactions.length;
}

export function markSynced(accountUid: string): void {
  db.prepare(`UPDATE accounts SET last_synced_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE uid = ?`).run(accountUid);
}

export function latestBookingDate(accountUid: string): string | null {
  const row = db.prepare(`SELECT MAX(booking_date) AS d FROM transactions WHERE account_uid = ? AND status = 'BOOK'`).get(accountUid) as
    | { d: string | null }
    | undefined;
  return row?.d ?? null;
}

export interface TransactionRow {
  id: string;
  account_uid: string;
  account_name: string | null;
  aspsp_name: string;
  amount: number;
  currency: string;
  status: string;
  booking_date: string | null;
  value_date: string | null;
  counterparty: string | null;
  description: string | null;
  bank_code: string | null;
  mcc: string | null;
  category: string | null;
  category_source: string | null;
  is_internal: number;
  recurring_id: string | null;
}

export interface TransactionFilter {
  accountUid?: string;
  q?: string;
  category?: string; // category id, or "uncategorized"
  includeInternal?: boolean;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export function listTransactions(opts: TransactionFilter = {}): TransactionRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.accountUid) {
    where.push("t.account_uid = ?");
    params.push(opts.accountUid);
  }
  if (opts.q) {
    where.push("(t.counterparty LIKE ? OR t.description LIKE ? OR CAST(t.amount AS TEXT) LIKE ?)");
    const like = `%${opts.q}%`;
    params.push(like, like, like);
  }
  if (opts.category === "uncategorized") where.push("t.category IS NULL AND t.is_internal = 0");
  else if (opts.category) {
    where.push("t.category = ?");
    params.push(opts.category);
  }
  if (!opts.includeInternal && opts.category !== "internal") where.push("t.is_internal = 0");
  if (opts.from) {
    where.push("t.booking_date >= ?");
    params.push(opts.from);
  }
  if (opts.to) {
    where.push("t.booking_date <= ?");
    params.push(opts.to);
  }
  params.push(Math.min(opts.limit ?? 200, 5000), opts.offset ?? 0);
  return db
    .prepare(
      `
      SELECT t.id, t.account_uid, COALESCE(a.display_name, a.name) AS account_name, s.aspsp_name, t.amount, t.currency, t.status,
             t.booking_date, t.value_date, t.counterparty, t.description, t.bank_code, t.mcc,
             t.category, t.category_source, t.is_internal, t.recurring_id
      FROM transactions t
      JOIN accounts a ON a.uid = t.account_uid
      JOIN sessions s ON s.id = a.session_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY COALESCE(t.booking_date, t.value_date, t.transaction_date) DESC, t.created_at DESC
      LIMIT ? OFFSET ?
    `,
    )
    .all(...params) as unknown as TransactionRow[];
}

export function getTransaction(id: string): TransactionRow | undefined {
  return db
    .prepare(
      `SELECT t.*, COALESCE(a.display_name, a.name) AS account_name, s.aspsp_name
       FROM transactions t JOIN accounts a ON a.uid = t.account_uid JOIN sessions s ON s.id = a.session_id WHERE t.id = ?`,
    )
    .get(id) as TransactionRow | undefined;
}

export function counts() {
  return db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM sessions) AS sessions,
              (SELECT COUNT(*) FROM accounts) AS accounts,
              (SELECT COUNT(*) FROM transactions) AS transactions`,
    )
    .get() as { sessions: number; accounts: number; transactions: number };
}
