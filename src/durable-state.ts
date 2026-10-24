import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { StoreData } from "./store.ts";

export interface StateRow { revision: number; envelope: string; operation_id: string; matched_operation?: boolean }
export interface StateBackend { read(operation?: string): StateRow; commit(expected: number, envelope: string, operation: string): StateRow }
export class StateRpcError extends Error {
  status: number;
  constructor(status: number) { super(`State RPC HTTP ${status}`); this.status = status; }
}
const aad = Buffer.from("bankmcp-state-v1");

export function seal(data: unknown, key: Buffer): string {
  if (key.length !== 32) throw new Error("Invalid state encryption key");
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
  return Buffer.concat([Buffer.from("BMCS1"), nonce, cipher.getAuthTag(), encrypted]).toString("base64");
}

export function unseal(envelope: string, key: Buffer): unknown {
  try {
    const raw = Buffer.from(envelope, "base64");
    if (raw.subarray(0, 5).toString() !== "BMCS1" || raw.length < 34 || key.length !== 32) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(5, 17));
    decipher.setAAD(aad); decipher.setAuthTag(raw.subarray(17, 33));
    return JSON.parse(Buffer.concat([decipher.update(raw.subarray(33)), decipher.final()]).toString());
  } catch { throw new Error("State authentication failed"); }
}

export function validateState(value: unknown): asserts value is StoreData {
  const d = value as StoreData;
  const record = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
  if (!d || d.version !== 1 || ![d.sessions, d.accounts, d.watches, d.pending_auth, d.oauth?.clients, d.oauth?.codes, d.oauth?.tokens].every(record)) throw new Error("Invalid durable state");
  for (const [id, s] of Object.entries(d.sessions)) {
    if (s.id !== id || !s.bank?.name || !s.bank.country || !s.psu_type || !Number.isFinite(Date.parse(s.valid_until)) || !Number.isFinite(Date.parse(s.created))) throw new Error("Invalid durable session");
  }
  for (const [uid, a] of Object.entries(d.accounts)) {
    if (a.uid !== uid || !d.sessions[a.session_id] || !a.identification_hash || !a.currency) throw new Error("Invalid durable account");
  }
  for (const [hash, token] of Object.entries(d.oauth.tokens)) {
    if (!/^[a-f0-9]{64}$/.test(hash) || !["access", "refresh"].includes(token.kind) || !Number.isFinite(token.expires)) throw new Error("Invalid token hash record");
  }
}

export class SupabaseState implements StateBackend {
  private rpc(name: string, args: Record<string, unknown>): StateRow {
    let reply: { ok: boolean; status?: number; body: StateRow };
    try {
      reply = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./state-rpc.ts" : "./state-rpc.js", import.meta.url))], {
        input: JSON.stringify({ rpc: name, args }), encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
        windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      }));
    } catch { throw new Error("State transport outcome unknown"); }
    if (!reply.ok) { if (reply.status) throw new StateRpcError(reply.status); throw new Error("State transport outcome unknown"); }
    if (!reply.body || !Number.isSafeInteger(reply.body.revision) || typeof reply.body.envelope !== "string") throw new Error("Invalid state receipt");
    return reply.body;
  }
  read(operation?: string): StateRow { return this.rpc("bankmcp_state_read", { p_operation_id: operation ?? null }); }
  commit(expected: number, envelope: string, operation: string): StateRow {
    return this.rpc("bankmcp_state_commit", { p_expected: expected, p_envelope: envelope, p_operation_id: operation });
  }
}

export class DurableState {
  revision: number;
  private baseline: StoreData;
  private failed = false;
  private backend: StateBackend;
  private key: Buffer;
  constructor(backend: StateBackend, key: Buffer, initial: StateRow) {
    this.backend = backend; this.key = key;
    this.revision = initial.revision;
    const value = unseal(initial.envelope, key); validateState(value); this.baseline = value;
  }
  data(): StoreData { return structuredClone(this.baseline); }
  refresh(): StoreData {
    if (this.failed) throw new Error("State write requires operator resolution");
    const row = this.backend.read(), value = unseal(row.envelope, this.key); validateState(value);
    this.revision = row.revision; this.baseline = value; return this.data();
  }
  save(candidate: StoreData): void {
    if (this.failed) throw new Error("State write requires operator resolution");
    validateState(candidate);
    if (JSON.stringify(candidate) === JSON.stringify(this.baseline)) return;
    const envelope = seal(candidate, this.key), operation = randomUUID();
    let row: StateRow;
    try { row = this.backend.commit(this.revision, envelope, operation); }
    catch (error) {
      if (error instanceof StateRpcError && error.status === 409) {
        this.refresh();
        throw new Error("State revision conflict; mutation rejected, reload before trying again");
      }
      // Never retry a write. Resolve exactly this operation from its immutable receipt.
      try { row = this.backend.read(operation); }
      catch { this.failed = true; throw new Error("State write outcome unknown; resolve operation " + operation); }
      if (!row.matched_operation) { this.failed = true; throw new Error("State write unconfirmed; resolve operation " + operation); }
    }
    if (row.revision !== this.revision + 1 || row.envelope !== envelope || row.operation_id !== operation) {
      this.failed = true; throw new Error("State write receipt mismatch; operator resolution required");
    }
    this.revision = row.revision; this.baseline = structuredClone(candidate);
  }
}

// Serialize HTTP and background tasks within a process. Cross-instance writes
// are separately protected by the database CAS, including overlapping deploys.
let tail = Promise.resolve();
export async function acquireStateGate(): Promise<() => void> {
  let release!: () => void;
  const next = new Promise<void>(resolve => { release = resolve; });
  const previous = tail; tail = previous.then(() => next);
  await previous; return release;
}

export function stateConfigured(): boolean {
  const names = ["BANKMCP_STATE_SUPABASE_URL", "BANKMCP_STATE_ANON_KEY", "BANKMCP_STATE_ACCESS_TOKEN", "BANKMCP_STATE_ENCRYPTION_KEY"];
  const count = names.filter(n => process.env[n]).length;
  if (count && count !== names.length) throw new Error("Incomplete durable state configuration");
  return count === names.length;
}
