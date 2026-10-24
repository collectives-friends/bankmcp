# Durable BankMCP state on the existing Supabase project

Production may use the four `BANKMCP_STATE_*` environment variables:
`SUPABASE_URL`, `ANON_KEY`, `ACCESS_TOKEN`, `ENCRYPTION_KEY` (each prefixed
`BANKMCP_STATE_`). Provision `supabase-state.sql` and a per-server state row with
an access-token SHA-256 and an authenticated AES-256-GCM envelope. These secrets
belong in the existing Doppler source and the hosting secret settings, never Git.
The server receives no Supabase service-role key. Anonymous table access is
revoked; the two narrow RPCs additionally require the per-server access token.

State contains all bank grants, account identities, labels, pending auth,
watches, OAuth client registrations, one-use codes and token hashes. Actual
OAuth bearer and refresh tokens remain SHA-256 indexed, never stored as values.
Remote mode writes no plaintext local `bank.json`. Encrypted revisions and
operation receipts remain in Supabase for recovery. Do not restore an earlier
revision blindly: that can resurrect revoked tokens or spent authorization codes.

The existing synchronous Store API uses a bounded isolated Node child to perform
each remote RPC before returning. This intentionally trades throughput for a
small, auditable change: there are no detached persistence promises. Requests
and background work share a gate held until their actual operation completes,
including after client disconnect. Database revision CAS protects overlapping
instances. A conflict rejects the current mutation; an uncertain write is read
back by its exact operation id, never blindly repeated. Unresolved outcomes fail
closed and require operator investigation. Local/stdio mode retains its original
filesystem store when no durable environment is configured.

## First cutover preserving existing bank grants

1. Preserve the running deployment, its existing Enable Banking application/key,
   admin signing secret and public URL. Capture authenticated `consent_status`,
   `list_accounts` and `list_watches`; keep raw evidence encrypted outside Git.
2. Seed an encrypted `bankmcp-existing-grants-v1` object in the existing database,
   recording the exact session ids, account uids, bank/currency and labels. This
   recovery mode requires zero watches and zero pending bank logins; these public
   tools are not a full store export. Nonempty watches require a complete export.
3. At startup the new code reads each existing Enable Banking session and its
   `accounts_data`, then fetches account details. It requires every exact uid,
   the original provider identification hash, session ownership and currency,
   and preserves the provider's full expiry and creation timestamps. No new bank
   consent is created and no identification hash is derived from an account number.
4. Only after verified durable commit does the new instance create its listener.
   Failed recovery must leave the old deployment active. A public-tool bootstrap
   cannot preserve previously issued client OAuth token hashes; MCP clients may
   need a fresh application login. Existing bank consents remain unchanged. The
   Finance importer already obtains a fresh access token for every run.
5. Read back all session/uid/hash bindings, compare the pre-cutover baseline and
   run a read-only account check. Redeploy the same code with an empty local data
   directory and verify identical durable bindings and OAuth behavior again.
   Do not reset the database to the bootstrap object after a successful cutover.

Bank consent expiry and provider revocation still apply normally. A healthy
durable store does not extend access beyond the bank's approval.
