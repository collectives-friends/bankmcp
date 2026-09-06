import { accessSync, constants, existsSync, mkdirSync, readFileSync } from "node:fs";

const port = Number(process.env.PORT ?? 8080);

export const config = {
  appId: process.env.EB_APP_ID ?? "",
  privateKey: process.env.EB_PRIVATE_KEY ?? "",
  privateKeyPath: process.env.EB_PRIVATE_KEY_PATH ?? "",
  apiBase: process.env.EB_API_BASE ?? "https://api.enablebanking.com",
  country: (process.env.DEFAULT_COUNTRY ?? "DK").toUpperCase(),
  port,
  baseUrl: (process.env.BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, ""),
  dataDir: process.env.DATA_DIR ?? "./data",
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH ?? "",
  adminPassword: process.env.ADMIN_PASSWORD ?? "",
  notifyWebhookUrl: process.env.NOTIFY_WEBHOOK_URL ?? "",
  // Optional: terminate TLS in the process itself (for running on your own
  // machine). Hosted deployments normally get TLS from the platform.
  tlsCertPath: process.env.TLS_CERT_PATH ?? "",
  tlsKeyPath: process.env.TLS_KEY_PATH ?? "",
  // Unattended polling for watches: PSD2 allows at most four account accesses
  // per day without the account holder present.
  pollIntervalHours: Number(process.env.POLL_INTERVAL_HOURS ?? 6),
};

export function tlsOptions(): { cert: string; key: string } | undefined {
  if (!config.tlsCertPath || !config.tlsKeyPath) return undefined;
  return { cert: readFileSync(config.tlsCertPath, "utf8"), key: readFileSync(config.tlsKeyPath, "utf8") };
}

const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Human-readable list of what is still missing before the server can run. */
export function setupProblems(): string[] {
  const problems: string[] = [];
  if (!config.appId) problems.push("EB_APP_ID is not set");
  else if (!looksLikeUuid.test(config.appId)) problems.push("EB_APP_ID does not look like a UUID");
  if (!config.privateKey && !config.privateKeyPath) problems.push("Set EB_PRIVATE_KEY (base64 of the .pem) or EB_PRIVATE_KEY_PATH");
  else if (!config.privateKey && !existsSync(config.privateKeyPath)) problems.push(`Private key not found at ${config.privateKeyPath}`);
  else {
    try {
      const pem = readPrivateKey();
      if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) problems.push("The private key is not a PEM file (expected -----BEGIN PRIVATE KEY-----)");
    } catch (err) {
      problems.push(`Cannot read private key: ${(err as Error).message}`);
    }
  }
  if (!config.adminPasswordHash && !config.adminPassword) problems.push("Set ADMIN_PASSWORD_HASH (run `npm run hash-password`) or ADMIN_PASSWORD");
  if (!/^https?:\/\//.test(config.baseUrl)) problems.push("BASE_URL must start with http:// or https://");
  try {
    mkdirSync(config.dataDir, { recursive: true });
    accessSync(config.dataDir, constants.W_OK);
  } catch {
    problems.push(`DATA_DIR  is not writable by this process (check volume permissions)`);
  }
  return problems;
}

export function isConfigured(): boolean {
  return setupProblems().length === 0;
}

export function readPrivateKey(): string {
  if (config.privateKey) {
    const raw = config.privateKey.trim();
    if (raw.startsWith("-----")) return raw.replace(/\\n/g, "\n");
    return Buffer.from(raw, "base64").toString("utf8");
  }
  return readFileSync(config.privateKeyPath, "utf8");
}
