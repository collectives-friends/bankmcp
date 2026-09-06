import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "bank-setup-"));
process.env.DATA_DIR = dir;
for (const k of ["EB_APP_ID", "EB_PRIVATE_KEY", "EB_PRIVATE_KEY_PATH", "ADMIN_PASSWORD", "ADMIN_PASSWORD_HASH"]) delete process.env[k];
const { applySetup, setupAvailable } = await import("../src/setup.ts");
const { config, setupProblems } = await import("../src/config.ts");
const { verifyPassword } = await import("../src/auth.ts");

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;

test("a fresh install offers setup and rejects bad input", () => {
  assert.equal(setupAvailable(), true);
  assert.match(applySetup({ app_id: "nope", pem, password: "a-long-password!", password2: "a-long-password!" })!, /UUID/);
  assert.match(applySetup({ app_id: "11111111-2222-3333-4444-555555555555", pem: "hello", password: "a-long-password!", password2: "a-long-password!" })!, /key file/);
  assert.match(applySetup({ app_id: "11111111-2222-3333-4444-555555555555", pem, password: "short", password2: "short" })!, /12 characters/);
  assert.match(applySetup({ app_id: "11111111-2222-3333-4444-555555555555", pem, password: "a-long-password!", password2: "different-password" })!, /match/);
  assert.equal(setupAvailable(), true, "nothing was stored by failed attempts");
});

test("valid setup stores key, id and password hash; the page then closes", () => {
  assert.equal(applySetup({ app_id: "11111111-2222-3333-4444-555555555555", pem, password: "a-long-password!", password2: "a-long-password!", country: "dk" }), null);
  assert.equal(config.appId, "11111111-2222-3333-4444-555555555555");
  assert.equal(config.country, "DK");
  assert.ok(existsSync(join(dir, "enablebanking.pem")));
  assert.ok(readFileSync(join(dir, "settings.json"), "utf8").includes("scrypt$"));
  assert.equal(verifyPassword("a-long-password!"), true);
  assert.equal(verifyPassword("wrong"), false);
  assert.deepEqual(setupProblems(), []);
  assert.equal(setupAvailable(), false);
});
