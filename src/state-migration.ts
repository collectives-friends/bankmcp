// Recover existing bank grants by their provider-issued session IDs. This makes
// no new consent and never substitutes an IBAN-derived identification hash.
import { randomUUID } from "node:crypto";
import { DurableState, SupabaseState, seal, unseal, validateState, stateConfigured } from "./durable-state.ts";
import { store, type StoreData, type StoredAccount, type Watch } from "./store.ts";
import { eb, type SessionStatus, type AccountResource } from "./enablebanking.ts";

export interface Bootstrap {
  kind: "bankmcp-existing-grants-v1";
  sessions: Array<{ id: string; bank: string; accounts: number }>;
  accounts: Array<{ uid: string; bank: string; label?: string | null; currency: string }>;
  watches: Watch[];
}
interface Provider {
  getSession(id: string): Promise<SessionStatus>;
  getAccountDetails(uid: string): Promise<AccountResource>;
}

export async function recoverGrants(seed: Bootstrap, provider: Provider): Promise<StoreData> {
  // list_watches omits seen history. Non-empty watches need a complete store
  // export, not a lossy reconstruction from the public tool response.
  if (seed.kind !== "bankmcp-existing-grants-v1" || !seed.sessions.length || !seed.accounts.length || !Array.isArray(seed.watches) || seed.watches.length) throw new Error("Invalid migration seed or watches require full export");
  const result: StoreData = { version: 1, sessions: {}, accounts: {}, pending_auth: {}, watches: {}, oauth: { clients: {}, codes: {}, tokens: {} } };
  const expected = new Set(seed.accounts.map(a => a.uid));
  if (expected.size !== seed.accounts.length || new Set(seed.sessions.map(s => s.id)).size !== seed.sessions.length) throw new Error("Duplicate migration identity");
  for (const prior of seed.sessions) {
    const live = await provider.getSession(prior.id);
    const bank = `${live.aspsp.name} (${live.aspsp.country})`;
    if (live.status !== "AUTHORIZED" || bank !== prior.bank || !live.psu_type || !live.created || !live.accounts_data || live.accounts.length !== prior.accounts || Date.parse(live.access.valid_until) <= Date.now()) throw new Error("Provider grant does not match migration seed");
    if (new Set(live.accounts).size !== live.accounts.length || live.accounts_data.length !== live.accounts.length || new Set(live.accounts_data.map(a => a.uid)).size !== live.accounts.length || live.accounts_data.some(a => !live.accounts.includes(a.uid))) throw new Error("Ambiguous provider account identities");
    result.sessions[prior.id] = { id: prior.id, bank: live.aspsp, psu_type: live.psu_type, valid_until: live.access.valid_until, created: live.created, status: live.status };
    for (const uid of live.accounts) {
      const priorAccount = seed.accounts.find(a => a.uid === uid && a.bank === bank);
      const identity = live.accounts_data.find(a => a.uid === uid);
      if (!priorAccount || !identity?.identification_hash || result.accounts[uid]) throw new Error("Missing or ambiguous provider account identity");
      const detail = await provider.getAccountDetails(uid);
      if (detail.uid !== uid || detail.identification_hash !== identity.identification_hash || detail.currency !== priorAccount.currency) throw new Error("Provider account details mismatch");
      const account: StoredAccount = {
        uid, session_id: prior.id, identification_hash: identity.identification_hash,
        currency: detail.currency, name: detail.name, product: detail.product,
        cash_account_type: detail.cash_account_type, iban: detail.account_id?.iban,
        other_id: detail.account_id?.other?.identification, label: priorAccount.label ?? undefined,
      };
      result.accounts[uid] = account;
    }
  }
  if (Object.keys(result.accounts).length !== expected.size || [...expected].some(uid => !result.accounts[uid])) throw new Error("Migration would lose an account");
  for (const watch of seed.watches) {
    if (!result.accounts[watch.account] || result.watches[watch.id]) throw new Error("Migration watch mismatch");
    result.watches[watch.id] = structuredClone(watch);
  }
  validateState(result); return result;
}

export async function initializeDurableStore(): Promise<void> {
  if (!stateConfigured()) return;
  const backend = new SupabaseState(), key = Buffer.from(process.env.BANKMCP_STATE_ENCRYPTION_KEY!, "base64");
  let row = backend.read();
  const initial = unseal(row.envelope, key);
  if ((initial as Bootstrap)?.kind === "bankmcp-existing-grants-v1") {
    const recovered = await recoverGrants(initial as Bootstrap, eb);
    const operation = randomUUID(), envelope = seal(recovered, key);
    const expected = row.revision + 1;
    try { row = backend.commit(row.revision, envelope, operation); }
    catch {
      const resolved = backend.read(operation);
      if (!resolved.matched_operation || resolved.envelope !== envelope) throw new Error("Migration write unconfirmed; inspect operation " + operation);
      row = resolved;
    }
    if (row.revision !== expected || row.operation_id !== operation || row.envelope !== envelope) throw new Error("Migration receipt mismatch");
    if (JSON.stringify(unseal(row.envelope, key)) !== JSON.stringify(recovered)) throw new Error("Migration state readback mismatch");
  }
  const durable = new DurableState(backend, key, row), shared = store();
  shared.data = durable.data(); shared.durable = durable;
}
