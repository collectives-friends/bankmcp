// Isolated synchronous-store transport. Credentials arrive through the environment
// and request body through stdin, never argv. Only ciphertext leaves this process.
import { readFileSync } from "node:fs";

try {
  const request = JSON.parse(readFileSync(0, "utf8")) as { rpc: string; args: Record<string, unknown> };
  if (!["bankmcp_state_read", "bankmcp_state_commit"].includes(request.rpc)) throw new Error();
  const base = new URL(process.env.BANKMCP_STATE_SUPABASE_URL!);
  if (base.protocol !== "https:" || base.pathname !== "/" || base.search || base.hash || base.username || base.password) throw new Error();
  const key = process.env.BANKMCP_STATE_ANON_KEY!;
  const response = await fetch(new URL("/rest/v1/rpc/" + request.rpc, base), {
    method: "POST", signal: AbortSignal.timeout(12_000),
    headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ ...request.args, p_access_token: process.env.BANKMCP_STATE_ACCESS_TOKEN }),
  });
  if (!response.ok) process.stdout.write(JSON.stringify({ ok: false, status: response.status }));
  else process.stdout.write(JSON.stringify({ ok: true, body: await response.json() }));
} catch {
  process.stdout.write(JSON.stringify({ ok: false, status: null }));
}
