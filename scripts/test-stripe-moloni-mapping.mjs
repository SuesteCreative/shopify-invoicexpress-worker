// Stripe → Moloni end-to-end with explicit product mappings.
// Creates a Stripe product+price in test mode, a Moloni product manually,
// inserts the mapping in D1, then synthesizes normalized payloads matching
// stripe-source.ts' output (charge + invoice shapes) and runs them through
// the patched Moloni adapter logic. Verifies mapping override + reconcile
// invariant across 4 scenarios (tax=0, tax=23, multi-line, partial map).

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const env = Object.fromEntries(
    readFileSync(".env.test.local", "utf-8")
        .split("\n").filter(l => l && !l.startsWith("#") && l.includes("="))
        .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const TEST_USER_ID = "user_RIOKO_STRIPE_MAPPING_TEST";

// ── Stripe API ─────────────────────────────────────────────────────────────
async function stripe(method, path, body) {
    const init = {
        method,
        headers: {
            "Authorization": `Bearer ${env.STRIPE_TEST_KEY}`,
            "Content-Type": "application/x-www-form-urlencoded",
        },
    };
    if (body) init.body = new URLSearchParams(body).toString();
    const res = await fetch(`https://api.stripe.com/v1${path}`, init);
    return res.json();
}

// ── Moloni API ─────────────────────────────────────────────────────────────
function formEncode(obj, prefix = "") {
    const parts = [];
    for (const [k, v] of Object.entries(obj)) {
        if (v === undefined || v === null) continue;
        const key = prefix ? `${prefix}[${k}]` : k;
        if (Array.isArray(v)) {
            v.forEach((item, i) => {
                const idxKey = `${key}[${i}]`;
                if (item !== null && typeof item === "object") parts.push(formEncode(item, idxKey));
                else parts.push(`${encodeURIComponent(idxKey)}=${encodeURIComponent(String(item))}`);
            });
        } else if (typeof v === "object") parts.push(formEncode(v, key));
        else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
    return parts.filter(Boolean).join("&");
}

const oauthUrl = new URL("https://api.moloni.pt/v1/grant/");
oauthUrl.searchParams.set("grant_type", "password");
oauthUrl.searchParams.set("client_id", env.MOLONI_CLIENT_ID);
oauthUrl.searchParams.set("client_secret", env.MOLONI_CLIENT_SECRET);
oauthUrl.searchParams.set("username", env.MOLONI_USERNAME);
oauthUrl.searchParams.set("password", env.MOLONI_PASSWORD);
const moloniToken = (await fetch(oauthUrl, { method: "POST" }).then(r => r.json())).access_token;
const COMPANY_ID = Number(env.MOLONI_COMPANY_ID);
const DOC_SET = Number(env.MOLONI_DOCUMENT_SET_ID);
const TAX_23 = 3476562;

async function m(path, body) {
    const url = `https://api.moloni.pt/v1${path}?access_token=${encodeURIComponent(moloniToken)}`;
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
        body: formEncode({ company_id: COMPANY_ID, ...body }),
    });
    const json = await res.json().catch(() => null);
    if (Array.isArray(json) && json.length > 0 && json.every(e => typeof e === "string")) {
        throw new Error(`${path}: ${JSON.stringify(json)}`);
    }
    if (json && typeof json === "object" && "valid" in json && json.valid === 0) {
        throw new Error(`${path} valid:0: ${JSON.stringify(json)}`);
    }
    return json;
}

function d1(sql) {
    return JSON.parse(execSync(`npx --no-install wrangler d1 execute rioko-db --remote --command ${JSON.stringify(sql)} --json`, { encoding: "utf8" }));
}

// ── Adapter replicas (matching patched moloni-destination.ts) ──────────────
function deriveRef(item) {
    const sku = (item.sku ?? "").trim();
    if (sku) return sku.slice(0, 30);
    if (!item.product_id && !item.variant_id) return "RIOKO-SHIPPING";
    if (item.variant_id) return `RIOKO-VARIANT-${item.variant_id}`.slice(0, 30);
    if (item.product_id) return `RIOKO-PRODUCT-${item.product_id}`.slice(0, 30);
    return "RIOKO-PLACEHOLDER";
}
function deriveName(item) {
    const sku = (item.sku ?? "").trim();
    const isShipping = !sku && !item.product_id && !item.variant_id;
    if (isShipping) return `Portes de envio${item.title ? ` — ${item.title}` : ""}`;
    if (item.variant_title) return `${item.title} / ${item.variant_title}`;
    return item.title ?? "Item";
}
function taxRateForItem(item, forceTaxRate) {
    if (forceTaxRate != null) return Number(forceTaxRate);
    return item.tax.unit_amount === 0 ? 0 : Number(item.tax.value);
}
async function ensureProduct(reference, name, taxRate) {
    try {
        const found = await m("/products/getByReference/", { reference });
        const match = Array.isArray(found) ? found[0] : null;
        if (match?.product_id) return Number(match.product_id);
    } catch { /* fall through */ }
    const cats = await m("/productCategories/getAll/", { parent_id: 0 });
    const units = await m("/measurementUnits/getAll/", {});
    const body = {
        category_id: cats[0]?.category_id, unit_id: units[0]?.unit_id, type: 1,
        name, reference, price: 0, has_stock: 0,
    };
    if (taxRate > 0) body.taxes = [{ tax_id: TAX_23, value: taxRate, order: 0, cumulative: 0 }];
    else body.exemption_reason = "M01";
    const created = await m("/products/insert/", body);
    return Number(created.product_id);
}
function computeExpectedGross(lines) {
    let total = 0;
    for (const l of lines) {
        const lineNet = (l.unit_price * l.quantity - (l.discount_amount ?? 0)) * (1 - (l.discount_percent ?? 0) / 100);
        const lineGross = lineNet * (1 + l.tax_rate / 100);
        total += Math.round(lineGross * 100) / 100;
    }
    return Math.round(total * 100) / 100;
}

// ── Setup: create Stripe product + price, Moloni product, mapping ──────────
console.log("=== SETUP ===");
const stripeProduct = await stripe("POST", "/products", {
    name: `Rioko Test Product ${Date.now()}`,
});
const stripePrice = await stripe("POST", "/prices", {
    product: stripeProduct.id,
    unit_amount: 4999,
    currency: "eur",
});
console.log(`Stripe product=${stripeProduct.id} price=${stripePrice.id} (€${stripePrice.unit_amount / 100})`);

// Second product (unmapped, will fallback to auto-create)
const stripeProduct2 = await stripe("POST", "/products", {
    name: `Rioko Unmapped ${Date.now()}`,
});
const stripePrice2 = await stripe("POST", "/prices", {
    product: stripeProduct2.id,
    unit_amount: 1500,
    currency: "eur",
});
console.log(`Stripe product2=${stripeProduct2.id} price2=${stripePrice2.id} (€${stripePrice2.unit_amount / 100})`);

const cats = await m("/productCategories/getAll/", { parent_id: 0 });
const units = await m("/measurementUnits/getAll/", {});
const MOLONI_REF = `RIOKO-STRIPE-${Date.now()}`;
const moloniProd = await m("/products/insert/", {
    category_id: cats[0].category_id, unit_id: units[0].unit_id, type: 1,
    name: `Moloni Catalog: ${stripeProduct.name}`,
    reference: MOLONI_REF,
    price: 49.99, has_stock: 0,
    taxes: [{ tax_id: TAX_23, value: 23, order: 0, cumulative: 0 }],
});
const MOLONI_PID = moloniProd.product_id;
console.log(`Moloni product id=${MOLONI_PID} ref=${MOLONI_REF}`);

const mapId = crypto.randomUUID();
const now = new Date().toISOString();
d1(`DELETE FROM product_mappings WHERE user_id = '${TEST_USER_ID}'`);
d1(`INSERT INTO product_mappings (id, user_id, source_kind, destination_kind, source_reference, destination_product_id, destination_reference, destination_name, source_name, created_at, updated_at) VALUES ('${mapId}', '${TEST_USER_ID}', 'stripe', 'moloni', '${stripePrice.id}', ${MOLONI_PID}, '${MOLONI_REF}', '${stripeProduct.name}', '${stripeProduct.name}', '${now}', '${now}')`);
console.log(`Mapping inserted: ${stripePrice.id} → moloni ${MOLONI_PID}`);

// Load mapping (as worker would)
const rows = d1(`SELECT source_reference, destination_product_id FROM product_mappings WHERE user_id = '${TEST_USER_ID}' AND source_kind = 'stripe' AND destination_kind = 'moloni'`);
const mappings = new Map(rows[0].results.map(r => [r.source_reference, Number(r.destination_product_id)]));

const customers = await m("/customers/getByVat/", { vat: "999999990" });
const customerId = customers[0]?.customer_id;

// ── Stripe-source synthesis: charge shape (single line) ────────────────────
function synthesizeChargeNormalized(charge) {
    return {
        id: charge.id,
        reference: charge.id,
        order_number: 0,
        total: (charge.amount ?? 0) / 100,
        items: [{
            id: 1,
            product_id: 0,
            variant_id: 0,
            quantity: 1,
            unit_price: (charge.amount ?? 0) / 100,
            tax: { name: "VAT", value: 0, unit_amount: 0 },
            discount: { name: "", percent: 0 },
            title: charge.description ?? `Stripe charge ${charge.id}`,
            variant_title: null,
            sku: charge.price_id ?? "",
        }],
    };
}

// Stripe-source synthesis: invoice shape (multi-line)
function synthesizeInvoiceNormalized(lines, totalCents) {
    return {
        id: "in_synthetic",
        reference: "in_synthetic",
        order_number: 0,
        total: totalCents / 100,
        items: lines.map((l, idx) => ({
            id: idx + 1,
            product_id: 0,
            variant_id: 0,
            quantity: l.quantity ?? 1,
            unit_price: (l.amount ?? 0) / 100 / (l.quantity || 1),
            tax: { name: "VAT", value: 0, unit_amount: 0 },
            discount: { name: "", percent: 0 },
            title: l.description ?? "Item",
            variant_title: null,
            sku: l.price_id ?? "",
        })),
    };
}

const results = [];

async function runScenario(label, normalized, forceTaxRate, expectedGross) {
    console.log(`\n=== ${label} ===`);
    console.log(`  ${normalized.items.length} line(s), expected paid: ${expectedGross.toFixed(2)} EUR, force_tax_rate=${forceTaxRate ?? "(none)"}`);
    for (const it of normalized.items) console.log(`    sku=${it.sku} title=${it.title} qty=${it.quantity} unit=${it.unit_price}`);

    // Resolve products via adapter logic
    const byRef = new Map();
    for (const it of normalized.items) {
        const r = deriveRef(it);
        if (!byRef.has(r)) byRef.set(r, { name: deriveName(it), taxRate: taxRateForItem(it, forceTaxRate) });
    }
    const resolved = new Map();
    const usedMapping = new Set();
    for (const [ref, meta] of byRef) {
        const mapped = mappings.get(ref);
        if (mapped) { resolved.set(ref, mapped); usedMapping.add(ref); }
        else resolved.set(ref, await ensureProduct(ref, meta.name, meta.taxRate));
    }

    // Reconcile
    const reconcileLines = normalized.items.map(it => ({
        quantity: it.quantity,
        unit_price: it.unit_price,
        tax_rate: taxRateForItem(it, forceTaxRate),
        discount_percent: 0,
    }));
    const computed = computeExpectedGross(reconcileLines);
    if (Math.abs(computed - expectedGross) > 0.01) {
        throw new Error(`Reconcile drift in test setup: expected ${expectedGross} computed ${computed}`);
    }

    // Build & insert
    const today = new Date().toISOString().slice(0, 10);
    const products = normalized.items.map((it, idx) => {
        const r = deriveRef(it);
        const taxRate = taxRateForItem(it, forceTaxRate);
        const line = {
            product_id: resolved.get(r),
            name: deriveName(it),
            qty: it.quantity,
            price: it.unit_price,
            discount: 0,
            order: idx + 1,
        };
        const sku = (it.sku ?? "").trim();
        if (sku) line.summary = `SKU: ${sku}`;
        if (taxRate > 0) line.taxes = [{ tax_id: TAX_23, value: taxRate, order: 1, cumulative: 0 }];
        else line.exemption_reason = "M01";
        return line;
    });

    const inv = await m("/invoices/insert/", {
        document_set_id: DOC_SET, customer_id: customerId,
        date: today, expiration_date: today,
        our_reference: `RIOKO-STR-${Date.now()}`,
        products, status: 0,
        notes: `${label} — safe to delete`,
        exemption_reason: forceTaxRate == null || forceTaxRate === 0 ? "M01" : undefined,
    });
    const got = await m("/invoices/getOne/", { document_id: inv.document_id });
    const moloniGross = Number(got.net_value);
    const drift = Math.abs(moloniGross - expectedGross);
    console.log(`  Reconcile: computed ${computed.toFixed(2)} == expected ${expectedGross.toFixed(2)} ✓`);
    console.log(`  Moloni invoice: ${moloniGross.toFixed(2)} EUR  drift=${drift.toFixed(4)}`);

    const productsBack = got.products ?? [];
    const lineCheck = [];
    for (let i = 0; i < normalized.items.length; i++) {
        const expected = resolved.get(deriveRef(normalized.items[i]));
        const actual = Number(productsBack[i]?.product_id);
        const wasMapped = usedMapping.has(deriveRef(normalized.items[i]));
        lineCheck.push({ line: i + 1, expected, actual, mapped: wasMapped, match: expected === actual });
    }
    for (const c of lineCheck) console.log(`  Line ${c.line}: product_id=${c.actual} (expected ${c.expected})${c.mapped ? " [MAPPED]" : " [auto]"} ${c.match ? "✓" : "✗"}`);

    await m("/invoices/delete/", { document_id: inv.document_id });
    const pass = drift <= 0.01 && lineCheck.every(c => c.match);
    results.push({ label, pass, drift });
    return pass;
}

// ── Scenarios ──────────────────────────────────────────────────────────────
// A: Charge shape, mapped, tax=0 (default Stripe)
{
    const norm = synthesizeChargeNormalized({
        id: "ch_test_a", amount: 4999, description: stripeProduct.name, price_id: stripePrice.id,
    });
    await runScenario("Scenario A — charge shape, mapped, tax=0", norm, undefined, 49.99);
}

// B: Charge shape, mapped, force_tax_rate=23
{
    const norm = synthesizeChargeNormalized({
        id: "ch_test_b", amount: 4999, description: stripeProduct.name, price_id: stripePrice.id,
    });
    // 49.99 net * 1.23 = 61.4877 → 61.49 gross (Moloni rounds at line level)
    await runScenario("Scenario B — charge shape, mapped, force_tax_rate=23", norm, 23, 61.49);
}

// C: Invoice shape (multi-line), 2 prices both mapped (mapped via mapping table)
{
    // Map the 2nd price too
    const map2Id = crypto.randomUUID();
    d1(`INSERT INTO product_mappings (id, user_id, source_kind, destination_kind, source_reference, destination_product_id, destination_reference, destination_name, source_name, created_at, updated_at) VALUES ('${map2Id}', '${TEST_USER_ID}', 'stripe', 'moloni', '${stripePrice2.id}', ${MOLONI_PID}, '${MOLONI_REF}', 'shared', 'shared', '${now}', '${now}')`);
    // Reload mappings
    const rows2 = d1(`SELECT source_reference, destination_product_id FROM product_mappings WHERE user_id = '${TEST_USER_ID}' AND source_kind = 'stripe'`);
    for (const r of rows2[0].results) mappings.set(r.source_reference, Number(r.destination_product_id));

    const norm = synthesizeInvoiceNormalized([
        { quantity: 2, amount: 9998, description: stripeProduct.name, price_id: stripePrice.id },
        { quantity: 1, amount: 1500, description: stripeProduct2.name, price_id: stripePrice2.id },
    ], 9998 + 1500);
    // 2 * 49.99 + 15.00 = 114.98 (tax=0)
    await runScenario("Scenario C — invoice shape, 2 prices both mapped, tax=0", norm, undefined, 114.98);

    // Remove second mapping for scenario D
    d1(`DELETE FROM product_mappings WHERE id = '${map2Id}'`);
    mappings.delete(stripePrice2.id);
}

// D: Invoice shape, 1 mapped + 1 unmapped (unmapped auto-falls back)
{
    const norm = synthesizeInvoiceNormalized([
        { quantity: 1, amount: 4999, description: stripeProduct.name, price_id: stripePrice.id },
        { quantity: 1, amount: 1500, description: stripeProduct2.name, price_id: stripePrice2.id },
    ], 4999 + 1500);
    // 49.99 + 15.00 = 64.99 (tax=0)
    await runScenario("Scenario D — mapped + unmapped (fallback auto-create)", norm, undefined, 64.99);
}

// ── Cleanup ────────────────────────────────────────────────────────────────
console.log("\n=== CLEANUP ===");
// Locate auto-created Moloni products for the Stripe price references
for (const ref of [stripePrice2.id]) {
    try {
        const found = await m("/products/getByReference/", { reference: ref.slice(0, 30) });
        if (Array.isArray(found) && found[0]?.product_id) {
            await m("/products/delete/", { product_id: found[0].product_id });
            console.log(`Deleted auto-created Moloni product for ${ref}`);
        }
    } catch { }
}
await m("/products/delete/", { product_id: MOLONI_PID });
console.log("Deleted Moloni mapped product");
d1(`DELETE FROM product_mappings WHERE user_id = '${TEST_USER_ID}'`);
console.log("Mappings cleared");
await stripe("DELETE", `/products/${stripeProduct.id}`);
await stripe("DELETE", `/products/${stripeProduct2.id}`);
console.log("Stripe products archived");

// ── Summary ────────────────────────────────────────────────────────────────
console.log("\n========================================");
console.log("STRIPE → MOLONI MAPPING SUMMARY");
console.log("========================================");
for (const r of results) console.log(`  ${r.pass ? "✓" : "✗"}  ${r.label}  (drift=${r.drift.toFixed(4)})`);
const failed = results.filter(r => !r.pass);
if (failed.length > 0) { console.error(`\n${failed.length} FAILED`); process.exit(1); }
console.log(`\n${results.length} scenarios all passed.`);
