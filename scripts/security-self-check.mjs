// Self-check for security primitives in src/security.ts.
// Reimplements the algorithm in pure JS (the source file ships TS + Workers
// types that won't load in Node), then asserts behaviour.
//
//   node scripts/security-self-check.mjs

import assert from "node:assert/strict";

// --- timingSafeEqualStr (mirrors src/security.ts) ---
const encoder = new TextEncoder();
function timingSafeEqualStr(a, b) {
    const aBytes = encoder.encode(a);
    const bBytes = encoder.encode(b);
    const len = Math.max(aBytes.length, bBytes.length, 1);
    let diff = aBytes.length ^ bBytes.length;
    for (let i = 0; i < len; i++) {
        diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
    }
    return diff === 0;
}

assert.equal(timingSafeEqualStr("e3549eca4cb017439e609d674c2246da", "e3549eca4cb017439e609d674c2246da"), true, "equal strings");
assert.equal(timingSafeEqualStr("e3549eca4cb017439e609d674c2246da", "e3549eca4cb017439e609d674c2246db"), false, "diff last byte");
assert.equal(timingSafeEqualStr("a", ""), false, "diff length 1 vs 0");
assert.equal(timingSafeEqualStr("", ""), true, "both empty");
assert.equal(timingSafeEqualStr("short", "much-longer-string"), false, "diff length");

// Coarse timing observation: 1M comparisons of equal vs prefix-equal strings
// should not skew dramatically (constant-time loop walks full length both ways).
// Not a cryptographic guarantee, just a smoke check.
const A = "x".repeat(64);
const B = "x".repeat(64);
const C = "x".repeat(63) + "y";
const iter = 200_000;
const t1 = performance.now();
for (let i = 0; i < iter; i++) timingSafeEqualStr(A, B);
const tEq = performance.now() - t1;
const t2 = performance.now();
for (let i = 0; i < iter; i++) timingSafeEqualStr(A, C);
const tDiff = performance.now() - t2;
const skew = Math.abs(tEq - tDiff) / Math.max(tEq, tDiff);
console.log(`timingSafeEqualStr eq=${tEq.toFixed(1)}ms diff=${tDiff.toFixed(1)}ms skew=${(skew * 100).toFixed(1)}%`);
assert.ok(skew < 0.5, "timing skew too high — possible early-return leak");

// --- redactSecrets (mirrors src/security.ts) ---
const SECRET_KEYS = new Set([
    "client_secret", "password", "access_token", "refresh_token", "api_key",
    "apikey", "x-api-key", "shopify_token", "shopify_webhook_secret",
    "ix_api_key", "hmac_secret", "stripe_secret_key", "authorization",
]);
function redactSecrets(v) {
    if (v == null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(redactSecrets);
    const out = {};
    for (const [k, val] of Object.entries(v)) {
        if (SECRET_KEYS.has(k.toLowerCase())) out[k] = val ? "[REDACTED]" : val;
        else if (val && typeof val === "object") out[k] = redactSecrets(val);
        else out[k] = val;
    }
    return out;
}

const moloniErr = {
    error: "invalid_grant",
    client_id: "kapta-integrator",
    client_secret: "dd33809ba563eaf5db33ed7165bef35f1213edb8",
    username: "pedro@kapta.pt",
    password: "KAPTA.Moloni1*",
    grant_type: "password",
};
const cleaned = redactSecrets(moloniErr);
assert.equal(cleaned.client_secret, "[REDACTED]", "client_secret redacted");
assert.equal(cleaned.password, "[REDACTED]", "password redacted");
assert.equal(cleaned.error, "invalid_grant", "non-secret field preserved");
assert.equal(cleaned.client_id, "kapta-integrator", "client_id NOT in secret list");
assert.equal(cleaned.username, "pedro@kapta.pt", "username NOT in secret list");

const nested = redactSecrets({
    request: { headers: { authorization: "Bearer shpat_xxx", accept: "application/json" } },
    response: [{ access_token: "abc", expires_in: 3600 }],
});
assert.equal(nested.request.headers.authorization, "[REDACTED]");
assert.equal(nested.request.headers.accept, "application/json");
assert.equal(nested.response[0].access_token, "[REDACTED]");
assert.equal(nested.response[0].expires_in, 3600);

// Empty / falsy values should pass through (not yield "[REDACTED]" for empty string)
assert.equal(redactSecrets({ password: "" }).password, "", "empty password unchanged");
assert.equal(redactSecrets({ password: null }).password, null, "null password unchanged");

console.log("security-self-check ✓");
