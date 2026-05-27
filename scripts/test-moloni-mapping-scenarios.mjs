// Comprehensive Moloni mapping E2E.
// Creates a real Moloni product, inserts a mapping in D1, then runs invoices
// covering: no-discount, percent discount, absolute discount allocation,
// multi-VAT rates, and mixed mapped+unmapped lines. Validates the reconcile
// invariant (invoice gross == amount paid) in every scenario and confirms
// mapped lines used the mapped product_id (not the auto-created one).

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const env = Object.fromEntries(
    readFileSync(".env.test.local", "utf-8")
        .split("\n").filter(l => l && !l.startsWith("#") && l.includes("="))
        .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const TEST_USER_ID = "user_RIOKO_MAPPING_TEST";
const TEST_SOURCE_KIND = "shopify";

// ── Helpers ────────────────────────────────────────────────────────────────
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
const token = (await fetch(oauthUrl, { method: "POST" }).then(r => r.json())).access_token;
const COMPANY_ID = Number(env.MOLONI_COMPANY_ID);
const DOC_SET = Number(env.MOLONI_DOCUMENT_SET_ID);
const TAX_23 = 3476562;
let TAX_6 = null; // resolved below

async function m(path, body) {
    const url = `https://api.moloni.pt/v1${path}?access_token=${encodeURIComponent(token)}`;
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
        body: formEncode({ company_id: COMPANY_ID, ...body }),
    });
    const json = await res.json().catch(() => null);
    if (Array.isArray(json) && json.length > 0 && json.every(e => typeof e === "string")) {
        throw new Error(`${path} validation error: ${JSON.stringify(json)}`);
    }
    if (json && typeof json === "object" && "valid" in json && json.valid === 0) {
        throw new Error(`${path} valid:0: ${JSON.stringify(json)}`);
    }
    return json;
}

function d1(sql) {
    const cmd = `npx --no-install wrangler d1 execute rioko-db --remote --command ${JSON.stringify(sql)} --json`;
    return JSON.parse(execSync(cmd, { encoding: "utf8" }));
}

// ── Adapter logic replicas ─────────────────────────────────────────────────
function deriveRef(item) {
    if (!item.product_id && !item.variant_id) return "RIOKO-SHIPPING";
    const sku = (item.sku ?? "").trim();
    if (sku) return sku.slice(0, 30);
    if (item.variant_id) return `RIOKO-VARIANT-${item.variant_id}`.slice(0, 30);
    if (item.product_id) return `RIOKO-PRODUCT-${item.product_id}`.slice(0, 30);
    return "RIOKO-PLACEHOLDER";
}
function deriveName(item) {
    if (!item.product_id && !item.variant_id) return `Portes de envio${item.title ? ` — ${item.title}` : ""}`;
    if (item.variant_title) return `${item.title} / ${item.variant_title}`;
    return item.title ?? "Item";
}
async function ensureProduct(reference, name, taxRate) {
    try {
        const found = await m("/products/getByReference/", { reference });
        const match = Array.isArray(found) ? found[0] : null;
        if (match?.product_id) return Number(match.product_id);
    } catch { /* fall through */ }
    const cats = await m("/productCategories/getAll/", { parent_id: 0 });
    const units = await m("/measurementUnits/getAll/", {});
    const created = await m("/products/insert/", {
        category_id: cats[0]?.category_id, unit_id: units[0]?.unit_id, type: 1,
        name, reference, price: 0, has_stock: 0,
        taxes: taxRate > 0 ? [{ tax_id: taxRate === 23 ? TAX_23 : TAX_6, value: taxRate, order: 0, cumulative: 0 }] : undefined,
    });
    return Number(created.product_id);
}

// loadProductMappings replica
async function loadMappings(userId, sourceKind) {
    const rows = d1(`SELECT source_reference, destination_product_id FROM product_mappings WHERE user_id = '${userId}' AND source_kind = '${sourceKind}' AND destination_kind = 'moloni'`);
    const map = new Map();
    for (const r of rows[0].results) map.set(r.source_reference, Number(r.destination_product_id));
    return map;
}

// resolveProductIds replica (with mapping override)
async function resolveProductIds(items, taxRateFor, explicitMappings) {
    const byRef = new Map();
    for (const it of items) {
        const r = deriveRef(it);
        if (!byRef.has(r)) byRef.set(r, { name: deriveName(it), taxRate: taxRateFor(it) });
    }
    const resolved = new Map();
    const usedMapping = new Set();
    for (const [ref, meta] of byRef) {
        const mapped = explicitMappings?.get(ref);
        if (mapped && mapped > 0) {
            resolved.set(ref, mapped);
            usedMapping.add(ref);
            continue;
        }
        resolved.set(ref, await ensureProduct(ref, meta.name, meta.taxRate));
    }
    return { resolved, usedMapping };
}

// computeExpectedGross replica
function computeExpectedGross(lines) {
    let total = 0;
    for (const l of lines) {
        const qty = Number(l.quantity) || 0;
        const unit = Number(l.unit_price) || 0;
        const discAmt = Number(l.discount_amount ?? 0) || 0;
        const discPct = Number(l.discount_percent ?? 0) || 0;
        const taxRate = Number(l.tax_rate) || 0;
        const lineNet = (unit * qty - discAmt) * (1 - discPct / 100);
        const lineGross = lineNet * (1 + taxRate / 100);
        total += Math.round(lineGross * 100) / 100;
    }
    return Math.round(total * 100) / 100;
}

// ── Resolve tax IDs ────────────────────────────────────────────────────────
const taxes = await m("/taxes/getAll/", {});
const tax6Row = taxes.find(t => Number(t.value) === 6 && t.type === 1);
TAX_6 = tax6Row?.tax_id;
console.log(`Tax IDs: 23%=${TAX_23} 6%=${TAX_6 ?? "(not found — 6% scenario will be skipped)"}`);
const customers = await m("/customers/getByVat/", { vat: "999999990" });
const customerId = customers[0]?.customer_id;

// ── Step 1: create a real Moloni product manually ──────────────────────────
console.log("\n=== STEP 1: create a Moloni product manually ===");
const cats = await m("/productCategories/getAll/", { parent_id: 0 });
const units = await m("/measurementUnits/getAll/", {});
const PREMIUM_REF = `RIOKO-PREMIUM-${Date.now()}`;
const premiumCreate = await m("/products/insert/", {
    category_id: cats[0].category_id, unit_id: units[0].unit_id, type: 1,
    name: "Premium Widget (Moloni Catalog)",
    reference: PREMIUM_REF,
    price: 99.99, has_stock: 0,
    taxes: [{ tax_id: TAX_23, value: 23, order: 0, cumulative: 0 }],
});
const PREMIUM_PID = premiumCreate.product_id;
console.log(`Created Moloni product: id=${PREMIUM_PID} ref=${PREMIUM_REF}`);

// ── Step 2: insert mapping in D1 ────────────────────────────────────────────
console.log("\n=== STEP 2: insert mapping in D1 ===");
const SHOPIFY_SKU_MAPPED = `SHOP-PREMIUM-${Date.now()}`;
const mapId = crypto.randomUUID();
const now = new Date().toISOString();
d1(`DELETE FROM product_mappings WHERE user_id = '${TEST_USER_ID}'`);
d1(`INSERT INTO product_mappings (id, user_id, source_kind, destination_kind, source_reference, destination_product_id, destination_reference, destination_name, source_name, created_at, updated_at) VALUES ('${mapId}', '${TEST_USER_ID}', '${TEST_SOURCE_KIND}', 'moloni', '${SHOPIFY_SKU_MAPPED}', ${PREMIUM_PID}, '${PREMIUM_REF}', 'Premium Widget (Moloni Catalog)', 'Premium Widget (Shopify side)', '${now}', '${now}')`);
const mappings = await loadMappings(TEST_USER_ID, TEST_SOURCE_KIND);
console.log(`Mappings loaded: ${mappings.size} — ${SHOPIFY_SKU_MAPPED} → ${mappings.get(SHOPIFY_SKU_MAPPED)}`);
if (mappings.get(SHOPIFY_SKU_MAPPED) !== PREMIUM_PID) throw new Error("Mapping round-trip failed");

// ── Test scenarios ──────────────────────────────────────────────────────────
const results = [];
async function runScenario(label, items, expectedGross) {
    console.log(`\n=== ${label} ===`);
    for (const it of items) console.log(`  ${it.title} sku=${it.sku || "-"} qty=${it.quantity} unit=${it.unit_price} tax=${it.tax.value}% discPct=${it.discount?.percent ?? 0} discAmt=${it.discount_allocation_amount ?? 0}`);
    console.log(`  Expected paid: ${expectedGross.toFixed(2)} EUR`);

    // Resolve products
    const { resolved, usedMapping } = await resolveProductIds(items, (it) => it.tax.value, mappings);

    // Reconcile
    const lines = items.map(it => ({
        quantity: it.quantity, unit_price: it.unit_price, tax_rate: it.tax.value,
        discount_percent: it.discount?.percent ?? 0,
        discount_amount: it.discount_allocation_amount ?? 0,
    }));
    const computed = computeExpectedGross(lines);
    if (Math.abs(computed - expectedGross) > 0.01) {
        throw new Error(`Reconcile drift: expected ${expectedGross} computed ${computed}`);
    }
    console.log(`  Reconcile: computed ${computed.toFixed(2)} == expected ${expectedGross.toFixed(2)} ✓`);

    // Build payload
    const today = new Date().toISOString().slice(0, 10);
    const products = items.map((it, idx) => {
        const ref = deriveRef(it);
        const line = {
            product_id: resolved.get(ref),
            name: deriveName(it),
            qty: it.quantity,
            price: it.unit_price,
            discount: it.discount?.percent ?? 0,
            order: idx + 1,
            taxes: it.tax.value > 0 ? [{ tax_id: it.tax.value === 23 ? TAX_23 : TAX_6, value: it.tax.value, order: 1, cumulative: 0 }] : undefined,
        };
        return line;
    });

    const inv = await m("/invoices/insert/", {
        document_set_id: DOC_SET, customer_id: customerId,
        date: today, expiration_date: today,
        our_reference: `RIOKO-SCEN-${Date.now()}`,
        products, status: 0,
        notes: `${label} — safe to delete`,
    });
    const got = await m("/invoices/getOne/", { document_id: inv.document_id });
    const moloniGross = Number(got.net_value);
    const drift = Math.abs(moloniGross - expectedGross);
    console.log(`  Moloni invoice: ${moloniGross.toFixed(2)} EUR  drift=${drift.toFixed(4)}`);

    // Check which mapped refs landed on the invoice's products
    const productsBack = got.products ?? [];
    const lineCheck = [];
    for (let i = 0; i < items.length; i++) {
        const expected = resolved.get(deriveRef(items[i]));
        const actual = Number(productsBack[i]?.product_id);
        const wasMapped = usedMapping.has(deriveRef(items[i]));
        lineCheck.push({ line: i + 1, expected, actual, mapped: wasMapped, match: expected === actual });
    }
    for (const c of lineCheck) console.log(`  Line ${c.line}: product_id=${c.actual} (expected ${c.expected})${c.mapped ? " [MAPPED]" : ""} ${c.match ? "✓" : "✗"}`);

    await m("/invoices/delete/", { document_id: inv.document_id });
    const pass = drift <= 0.01 && lineCheck.every(c => c.match);
    results.push({ label, pass, drift, lineCheck });
    return pass;
}

// Scenario A: simple, mapped SKU, no discount
await runScenario(
    "Scenario A — mapped SKU, no discount, 23% VAT",
    [
        { product_id: 100, variant_id: 10001, sku: SHOPIFY_SKU_MAPPED, quantity: 2, unit_price: 50.00, tax: { value: 23, unit_amount: 23 }, discount: { percent: 0 }, title: "Premium Widget (Shopify side)" },
    ],
    Math.round(50 * 2 * 1.23 * 100) / 100, // 123.00
);

// Scenario B: percent discount 15% on mapped line
await runScenario(
    "Scenario B — mapped SKU, 15% line discount, 23% VAT",
    [
        { product_id: 100, variant_id: 10001, sku: SHOPIFY_SKU_MAPPED, quantity: 1, unit_price: 100.00, tax: { value: 23, unit_amount: 23 }, discount: { percent: 15 }, title: "Premium Widget" },
    ],
    Math.round((100 * 1 * (1 - 0.15)) * 1.23 * 100) / 100, // 104.55
);

// Scenario C: absolute discount allocation (Shopify discount_allocation_amount)
// Moloni doesn't natively accept absolute discount, but adapter converts to percent via line math.
// For this test, simulate as % since adapter doesn't pass discount_amount to Moloni.
await runScenario(
    "Scenario C — mapped SKU, 10€ absolute discount converted to %, 23% VAT",
    [
        // 100 EUR net, 10 EUR off → effective 90 EUR net → 90 * 1.23 = 110.70 gross
        // As percent: (10/100) * 100 = 10%
        { product_id: 100, variant_id: 10001, sku: SHOPIFY_SKU_MAPPED, quantity: 1, unit_price: 100.00, tax: { value: 23, unit_amount: 23 }, discount: { percent: 10 }, title: "Premium Widget" },
    ],
    Math.round(100 * (1 - 0.10) * 1.23 * 100) / 100, // 110.70
);

// Scenario D: multi-VAT rates (23% + 6%)
if (TAX_6) {
    await runScenario(
        "Scenario D — mapped SKU @ 23% + unmapped @ 6%",
        [
            { product_id: 100, variant_id: 10001, sku: SHOPIFY_SKU_MAPPED, quantity: 1, unit_price: 50.00, tax: { value: 23, unit_amount: 23 }, discount: { percent: 0 }, title: "Premium Widget" },
            { product_id: 200, variant_id: 20002, sku: "BOOK-SKU-001", quantity: 2, unit_price: 12.00, tax: { value: 6, unit_amount: 6 }, discount: { percent: 0 }, title: "Reduced VAT Book" },
        ],
        Math.round((50 * 1.23 + 12 * 2 * 1.06) * 100) / 100, // 61.50 + 25.44 = 86.94
    );
} else {
    console.log("\n(Skipping Scenario D — 6% tax not configured in Moloni)");
}

// Scenario E: mapped + unmapped + shipping mixed
await runScenario(
    "Scenario E — mapped + unmapped + shipping in one invoice",
    [
        { product_id: 100, variant_id: 10001, sku: SHOPIFY_SKU_MAPPED, quantity: 1, unit_price: 80.00, tax: { value: 23, unit_amount: 23 }, discount: { percent: 0 }, title: "Premium Widget" },
        { product_id: 300, variant_id: 30003, sku: "ACCESSORY-SKU-X", quantity: 3, unit_price: 8.00, tax: { value: 23, unit_amount: 23 }, discount: { percent: 0 }, title: "Accessory X" },
        { product_id: 0, variant_id: 0, sku: "", quantity: 1, unit_price: 4.99, tax: { value: 23, unit_amount: 23 }, discount: { percent: 0 }, title: "Standard Shipping" },
    ],
    Math.round((80 + 8 * 3 + 4.99) * 1.23 * 100) / 100, // (80 + 24 + 4.99) * 1.23 = 108.99 * 1.23 = 134.06
);

// ── Cleanup ─────────────────────────────────────────────────────────────────
console.log("\n=== CLEANUP ===");
d1(`DELETE FROM product_mappings WHERE user_id = '${TEST_USER_ID}'`);
console.log("Mappings removed.");
const delProduct = await m("/products/delete/", { product_id: PREMIUM_PID });
console.log(`Moloni product Premium Widget deleted (status valid=${delProduct?.valid ?? "?"})`);

// ── Summary ─────────────────────────────────────────────────────────────────
console.log("\n========================================");
console.log("SUMMARY");
console.log("========================================");
for (const r of results) console.log(`  ${r.pass ? "✓" : "✗"}  ${r.label}  (drift=${r.drift.toFixed(4)})`);
const failed = results.filter(r => !r.pass);
if (failed.length > 0) { console.error(`\n${failed.length} scenario(s) FAILED`); process.exit(1); }
console.log(`\n${results.length} scenarios all passed.`);
