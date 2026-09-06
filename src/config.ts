import { existsSync, readFileSync } from "node:fs";

const port = Number(process.env.PORT ?? 3000);

export const config = {
  appId: process.env.EB_APP_ID ?? "",
  privateKeyPath: process.env.EB_PRIVATE_KEY_PATH ?? "",
  apiBase: process.env.EB_API_BASE ?? "https://api.enablebanking.com",
  country: (process.env.EB_COUNTRY ?? "DK").toUpperCase(),
  historyDays: Number(process.env.EB_HISTORY_DAYS ?? 90),
  port,
  baseUrl: process.env.BASE_URL ?? `http://localhost:${port}`,
  dbPath: process.env.DB_PATH ?? "./data/dabba.db",
  // Enable Banking only accepts https redirect URLs for production apps, so
  // the local server can terminate TLS itself when a cert/key pair is given.
  tlsCertPath: process.env.TLS_CERT_PATH ?? "",
  tlsKeyPath: process.env.TLS_KEY_PATH ?? "",
};

export function tlsOptions(): { cert: string; key: string } | undefined {
  if (!config.tlsCertPath || !config.tlsKeyPath) return undefined;
  return { cert: readFileSync(config.tlsCertPath, "utf8"), key: readFileSync(config.tlsKeyPath, "utf8") };
}

const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Human-readable list of what is still missing before the API can be used. */
export function setupProblems(): string[] {
  const problems: string[] = [];
  if (!config.appId) problems.push("EB_APP_ID is not set in .env");
  else if (!looksLikeUuid.test(config.appId)) problems.push("EB_APP_ID does not look like a UUID");
  if (!config.privateKeyPath) problems.push("EB_PRIVATE_KEY_PATH is not set in .env");
  else if (!existsSync(config.privateKeyPath)) problems.push(`Private key not found at ${config.privateKeyPath}`);
  return problems;
}

export function isConfigured(): boolean {
  return setupProblems().length === 0;
}

export function readPrivateKey(): string {
  return readFileSync(config.privateKeyPath, "utf8");
}
