import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.EB_APP_ID = "11111111-2222-3333-4444-555555555555";
process.env.EB_PRIVATE_KEY = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" }) as string).toString("base64");
const { makeJwt } = await import("../src/enablebanking.ts");

test("JWT has the header and claims Enable Banking expects and verifies with the public key", () => {
  const jwt = makeJwt(1_700_000_000);
  const [h, p, sig] = jwt.split(".") as [string, string, string];
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { typ: "JWT", alg: "RS256", kid: process.env.EB_APP_ID });
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  assert.equal(claims.iss, "enablebanking.com");
  assert.equal(claims.aud, "api.enablebanking.com");
  assert.equal(claims.exp - claims.iat, 3600);
  assert.ok(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, "base64url")));
});
