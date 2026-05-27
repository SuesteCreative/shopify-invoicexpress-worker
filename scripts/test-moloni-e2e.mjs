// End-to-end Moloni test: replicates the patched adapter flow with per-item
// product references (SKU/variant_id/shipping fallback).

import { readFileSync } from "node:fs";

const env = Object.fromEntries(
    readFileSync(".env.test.local", "utf-8")
        .split("\n").filter(l => l && !l.startsWith("#") && l.includes("="))
        .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

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
const DEFAULT_TAX_ID = 3476562;

async function call(path, body) {
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

// Replicates adapter's ensureMoloniProduct
async function ensureProduct(reference, defaultName, taxRate) {
    try {
        const found = await call("/products/getByReference/", { reference });
        const match = Array.isArray(found) ? found[0] : null;
        if (match?.product_id) return { id: match.product_id, created: false };
    } catch { /* fall through */ }
    const cats = await call("/productCategories/getAll/", { parent_id: 0 });
    const categoryId = cats[0]?.category_id;
    const units = await call("/measurementUnits/getAll/", {});
    const unitId = units[0]?.unit_id;
    const created = await call("/products/insert/", {
        category_id: categoryId, unit_id: unitId, type: 1,
        name: defaultName, reference, price: 0, has_stock: 0,
        taxes: taxRate > 0 ? [{ tax_id: DEFAULT_TAX_ID, value: taxRate, order: 0, cumulative: 0 }] : undefined,
    });
    return { id: created.product_id, created: true };
}

// === Test: Shopify-like order with 2 distinct SKUs + 1 shipping line ===
const items = [
    { id: 1, product_id: 100, variant_id: 10001, sku: "RIOKO-TEST-SKU-A", title: "Test Item A", variant_title: null, qty: 2, unit_price: 10.00, tax: { value: 23, unit_amount: 23 } },
    { id: 2, product_id: 200, variant_id: 20002, sku: "RIOKO-TEST-SKU-B", title: "Test Item B", variant_title: null, qty: 1, unit_price: 15.00, tax: { value: 23, unit_amount: 23 } },
    { id: 3, product_id: 0, variant_id: 0, sku: "", title: "Standard Shipping", variant_title: null, qty: 1, unit_price: 5.00, tax: { value: 23, unit_amount: 23 } },
];

// Resolve per-item product_ids
function deriveRef(item) {
    if (!item.product_id && !item.variant_id) return "RIOKO-SHIPPING";
    if (item.sku && item.sku.trim()) return item.sku.trim().slice(0, 30);
    if (item.variant_id) return `RIOKO-VARIANT-${item.variant_id}`.slice(0, 30);
    return "RIOKO-PLACEHOLDER";
}

const refs = new Map();
for (const item of items) {
    const r = deriveRef(item);
    if (!refs.has(r)) refs.set(r, { name: item.title, taxRate: item.tax.value });
}

const productIds = new Map();
console.log("--- Resolving products ---");
for (const [ref, meta] of refs) {
    const { id, created } = await ensureProduct(ref, meta.name, meta.taxRate);
    productIds.set(ref, id);
    console.log(`  ${ref.padEnd(20)} → product_id=${id} ${created ? "(CREATED)" : "(reused)"}`);
}

// Customer
const customers = await call("/customers/getByVat/", { vat: "999999990" });
const customerId = customers[0]?.customer_id;

// Build invoice products
const today = new Date().toISOString().slice(0, 10);
const products = items.map((item, idx) => ({
    product_id: productIds.get(deriveRef(item)),
    name: item.title,
    qty: item.qty,
    price: item.unit_price,
    discount: 0,
    order: idx + 1,
    taxes: [{ tax_id: DEFAULT_TAX_ID, value: item.tax.value, order: 1, cumulative: 0 }],
}));

// Expected gross
const expectedGross = items.reduce((acc, it) => {
    const lineNet = it.unit_price * it.qty;
    const lineGross = lineNet * (1 + it.tax.value / 100);
    return acc + Math.round(lineGross * 100) / 100;
}, 0);
console.log(`\nExpected gross: ${expectedGross.toFixed(2)} EUR`);
// (10*2 + 15 + 5) * 1.23 = 40 * 1.23 = 49.20

const inv = await call("/invoices/insert/", {
    document_set_id: DOC_SET, customer_id: customerId, date: today, expiration_date: today,
    our_reference: `RIOKO-E2E-${Date.now()}`, products, status: 0, notes: "smoke test",
});
console.log(`Invoice ✓ document_id=${inv.document_id}`);

// Verify
const got = await call("/invoices/getOne/", { document_id: inv.document_id });
const moloniGross = Number(got.net_value);
const drift = Math.abs(moloniGross - expectedGross);
console.log(`Moloni net_value (real gross): ${moloniGross.toFixed(2)} EUR`);
console.log(`Drift: ${drift.toFixed(4)} EUR`);
if (drift > 0.01) {
    console.error("✗ DRIFT > 1¢");
    process.exit(1);
}
console.log("✓ Reconcile passes");

// Cleanup invoice (leave products — they're reusable for next invoices)
await call("/invoices/delete/", { document_id: inv.document_id });
console.log("Cleanup invoice ✓");

// --- 2nd run: verify products are REUSED (no duplicates) ---
console.log("\n--- 2nd run: reuse check ---");
const productIds2 = new Map();
for (const [ref, meta] of refs) {
    const { id, created } = await ensureProduct(ref, meta.name, meta.taxRate);
    productIds2.set(ref, id);
    console.log(`  ${ref.padEnd(20)} → product_id=${id} ${created ? "✗ DUPLICATE" : "✓ reused"}`);
    if (created) { console.error("Product was created twice!"); process.exit(1); }
}
console.log("\n✓ All products reused on 2nd lookup");
