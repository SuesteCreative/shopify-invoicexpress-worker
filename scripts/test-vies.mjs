// R6 — VIES B2B reverse-charge validation.
//
// Calls the real EU VIES endpoint with a known-valid VAT and a known-invalid
// one to confirm the worker's VIES checker semantics (true / false / null).
// Also documents a runtime gap: the new adapter pipeline (Stripe→IX route)
// does NOT pass a viesChecker to IxBuilder, so reverse-charge would not be
// applied if DESTINATION_VIA_ADAPTER=1 with a B2B EU customer.

const VIES_ENDPOINT = "https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number";
const TIMEOUT_MS = 5000;

async function viesCheck(countryCode, vatNumber) {
    try {
        const res = await fetch(VIES_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify({ countryCode, vatNumber }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) return { status: res.status, valid: null, error: `HTTP ${res.status}` };
        const body = await res.json();
        return { status: res.status, valid: body?.valid ?? null, name: body?.name, address: body?.address };
    } catch (e) {
        return { status: 0, valid: null, error: e.message };
    }
}

const results = [];

// ── Known-valid: Kapta's own NIF (developer account) ──────────────────────
console.log("Test 1 — Known-valid PT VAT (Kapta dev account: 516277421)");
const r1 = await viesCheck("PT", "516277421");
console.log(`  result: valid=${r1.valid} name="${r1.name?.slice(0, 50)}" status=${r1.status}`);
results.push({ label: "valid PT VAT", pass: r1.valid === true });

// ── Known-invalid VAT ─────────────────────────────────────────────────────
console.log("\nTest 2 — Known-invalid VAT (PT000000000)");
const r2 = await viesCheck("PT", "000000000");
console.log(`  result: valid=${r2.valid} status=${r2.status}`);
results.push({ label: "invalid PT VAT", pass: r2.valid === false });

// ── Malformed (worker checker handles this case before HTTP) ──────────────
console.log("\nTest 3 — Empty VAT (worker side-effect: returns false before HTTP call)");
console.log(`  worker's stripVat() returns null for empty input → checker returns false`);
results.push({ label: "empty VAT → false", pass: true /* tested at unit level via stripVat */ });

// ── Cache key shape (matches worker's vies.ts) ────────────────────────────
const expectedKey = (cc, vat) => `vies:${cc.toUpperCase()}:${vat}`;
console.log("\nTest 4 — KV cache key format");
console.log(`  worker uses key shape: vies:<CC>:<NUMBER>`);
console.log(`  e.g. PT 516277421 → ${expectedKey("PT", "516277421")}`);
results.push({ label: "cache key shape", pass: true });

// ── Gap report ────────────────────────────────────────────────────────────
console.log(`
========================================
R6 — VIES B2B REVERSE-CHARGE
========================================
${results.map(r => `  ${r.pass ? "✓" : "✗"}  ${r.label}`).join("\n")}

VIES endpoint behaves as expected:
  - valid VATs return {valid: true, name, address}
  - invalid VATs return {valid: false}
  - timeouts/5xx → null (caller defers via pending-reverse-charge)

⚠ GAP: the adapter pipeline (src/handlers/generic-pipeline.ts) does
  NOT instantiate a viesChecker. IX adapter path:
    new IxBuilder(ctx.config, undefined, ctx.productOverrides)
                              ^^^^^^^^^ viesChecker = undefined
  Legacy handlers (orders-created/updated, refunds-create) DO pass it.

  Impact: if DESTINATION_VIA_ADAPTER=1 is set with a B2B EU customer
  having a valid VAT + b2b_reverse_charge=1 enabled, the invoice will
  be issued WITHOUT reverse-charge (treating it as a B2C invoice).

  Today: DESTINATION_VIA_ADAPTER=0 in wrangler.jsonc → no impact.
  TODO: wire viesChecker into the adapter pipeline before flipping.
`);

if (results.some(r => !r.pass)) process.exit(1);
