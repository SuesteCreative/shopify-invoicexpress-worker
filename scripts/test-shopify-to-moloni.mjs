// End-to-end Shopify→Moloni dry-run.
// Reads REAL products from the Shopify dev store, synthesizes a paid-order
// payload around them, then walks the full adapter path against the live
// Moloni API: per-item product resolution, line build, reconcile, invoice
// insert, gross verify, cleanup.
//
// Bypasses the actual Shopify orders/paid webhook (blocked by Protected
// Customer Data on this dev store) — everything downstream is real.

import { readFileSync } from "node:fs";

const env = Object.fromEntries(
    readFileSync(".env.test.local", "utf-8")
        .split("\n").filter(l => l && !l.startsWith("#") && l.includes("="))
        .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

// ── Shopify: pull real products ────────────────────────────────────────────
const shopifyHeaders = {
    "X-Shopify-Access-Token": env.SHOPIFY_TEST_TOKEN,
    "Accept": "application/json",
};
const productsRes = await fetch(
    `https://${env.SHOPIFY_TEST_DOMAIN}/admin/api/${env.SHOPIFY_API_VERSION}/products.json?limit=3`,
    { headers: shopifyHeaders },
);
const { products } = await productsRes.json();
if (!products || products.length < 2) { console.error("Need at least 2 products"); process.exit(1); }

// Map real Shopify variants → normalized items
const p1 = products[0], p2 = products[1];
const v1 = p1.variants[0], v2 = p2.variants[0];
const items = [
    {
        id: 9001, product_id: p1.id, variant_id: v1.id,
        sku: v1.sku || `RIOKO-VARIANT-${v1.id}`,
        quantity: 1, unit_price: Number(v1.price),
        tax: { value: 23, unit_amount: 23 },
        discount: { name: "", percent: 0 },
        title: p1.title, variant_title: v1.title === "Default Title" ? null : v1.title,
    },
    {
        id: 9002, product_id: p2.id, variant_id: v2.id,
        sku: v2.sku || `RIOKO-VARIANT-${v2.id}`,
        quantity: 2, unit_price: Number(v2.price),
        tax: { value: 23, unit_amount: 23 },
        discount: { name: "", percent: 0 },
        title: p2.title, variant_title: v2.title === "Default Title" ? null : v2.title,
    },
    // Shipping line (no product_id/variant_id → RIOKO-SHIPPING)
    {
        id: 9003, product_id: 0, variant_id: 0, sku: "",
        quantity: 1, unit_price: 4.99,
        tax: { value: 23, unit_amount: 23 },
        discount: { name: "", percent: 0 },
        title: "Standard Shipping", variant_title: null,
    },
];

// Pretend Shopify total_price (gross, VAT-inclusive) is the sum of our lines
const expectedGross = items.reduce((acc, it) => {
    const lineNet = it.unit_price * it.quantity;
    const lineGross = lineNet * (1 + it.tax.value / 100);
    return acc + Math.round(lineGross * 100) / 100;
}, 0);
console.log(`Synthetic Shopify order:`);
console.log(`  ${items.length} lines, gross paid = ${expectedGross.toFixed(2)} EUR`);
for (const it of items) console.log(`    ${it.title} x${it.quantity} @ ${it.unit_price} (sku=${it.sku || "none"})`);

// ── Moloni: replicate adapter helpers ──────────────────────────────────────
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
const DEFAULT_TAX_ID = 3476562;

async function moloni(path, body) {
    const url = `https://api.moloni.pt/v1${path}?access_token=${encodeURIComponent(moloniToken)}`;
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

function deriveRef(item) {
    if (!item.product_id && !item.variant_id) return "RIOKO-SHIPPING";
    const sku = (item.sku ?? "").trim();
    if (sku) return sku.slice(0, 30);
    if (item.variant_id) return `RIOKO-VARIANT-${item.variant_id}`.slice(0, 30);
    if (item.product_id) return `RIOKO-PRODUCT-${item.product_id}`.slice(0, 30);
    return "RIOKO-PLACEHOLDER";
}

function deriveName(item) {
    if (!item.product_id && !item.variant_id) {
        return `Portes de envio${item.title ? ` — ${item.title}` : ""}`.slice(0, 200);
    }
    if (item.variant_title) return `${item.title} / ${item.variant_title}`.slice(0, 200);
    return (item.title ?? "Item").slice(0, 200);
}

async function ensureProduct(reference, defaultName, taxRate) {
    try {
        const found = await moloni("/products/getByReference/", { reference });
        const match = Array.isArray(found) ? found[0] : null;
        if (match?.product_id) return { id: match.product_id, created: false };
    } catch { /* fall through */ }
    const cats = await moloni("/productCategories/getAll/", { parent_id: 0 });
    const units = await moloni("/measurementUnits/getAll/", {});
    const created = await moloni("/products/insert/", {
        category_id: cats[0]?.category_id, unit_id: units[0]?.unit_id, type: 1,
        name: defaultName, reference, price: 0, has_stock: 0,
        taxes: taxRate > 0 ? [{ tax_id: DEFAULT_TAX_ID, value: taxRate, order: 0, cumulative: 0 }] : undefined,
    });
    return { id: created.product_id, created: true };
}

// ── Resolve products (de-duped) ────────────────────────────────────────────
const refs = new Map();
for (const item of items) {
    const r = deriveRef(item);
    if (!refs.has(r)) refs.set(r, { name: deriveName(item), taxRate: item.tax.value });
}
console.log(`\nResolving ${refs.size} unique Moloni products (from ${items.length} lines):`);
const productIds = new Map();
for (const [ref, meta] of refs) {
    const { id, created } = await ensureProduct(ref, meta.name, meta.taxRate);
    productIds.set(ref, id);
    console.log(`  ${ref.padEnd(30)} → product_id=${id} ${created ? "(CREATED)" : "(reused)"}`);
}

// ── Reconcile (worker would throw here on drift > 1¢) ──────────────────────
const reconcileLines = items.map(it => ({
    quantity: it.quantity, unit_price: it.unit_price,
    tax_rate: it.tax.value, discount_percent: it.discount?.percent ?? 0,
}));
const expected = reconcileLines.reduce((acc, l) => {
    const lineNet = l.unit_price * l.quantity * (1 - l.discount_percent / 100);
    const lineGross = lineNet * (1 + l.tax_rate / 100);
    return acc + Math.round(lineGross * 100) / 100;
}, 0);
const reconcileDrift = Math.abs(expected - expectedGross);
if (reconcileDrift > 0.01) {
    console.error(`✗ Reconcile drift > 1¢: expected=${expectedGross}, computed=${expected}`);
    process.exit(1);
}
console.log(`\nReconcile pre-POST: expected ${expectedGross.toFixed(2)} ≈ computed ${expected.toFixed(2)} ✓`);

// ── Insert invoice ──────────────────────────────────────────────────────────
const customers = await moloni("/customers/getByVat/", { vat: "999999990" });
const customerId = customers[0]?.customer_id;

const today = new Date().toISOString().slice(0, 10);
const products_payload = items.map((item, idx) => ({
    product_id: productIds.get(deriveRef(item)),
    name: deriveName(item),
    summary: item.sku && (item.product_id || item.variant_id) ? `SKU: ${item.sku}` : undefined,
    qty: item.quantity,
    price: item.unit_price,
    discount: item.discount?.percent ?? 0,
    order: idx + 1,
    taxes: item.tax.value > 0 ? [{ tax_id: DEFAULT_TAX_ID, value: item.tax.value, order: 1, cumulative: 0 }] : undefined,
}));

const inv = await moloni("/invoices/insert/", {
    document_set_id: DOC_SET, customer_id: customerId, date: today, expiration_date: today,
    our_reference: `RIOKO-SHOP-E2E-${Date.now()}`, products: products_payload, status: 0,
    notes: "Shopify→Moloni dry-run — safe to delete",
});
console.log(`\nInvoice ✓ document_id=${inv.document_id}`);

// ── Verify gross matches Shopify total ──────────────────────────────────────
const got = await moloni("/invoices/getOne/", { document_id: inv.document_id });
const moloniGross = Number(got.net_value); // Moloni's "net_value" is actually with-VAT
const drift = Math.abs(moloniGross - expectedGross);
console.log(`Shopify paid:   ${expectedGross.toFixed(2)} EUR`);
console.log(`Moloni invoice: ${moloniGross.toFixed(2)} EUR (net_value field)`);
console.log(`Drift:          ${drift.toFixed(4)} EUR`);
if (drift > 0.01) { console.error("✗ DRIFT > 1¢"); process.exit(1); }
console.log("✓ Invariant holds: invoice gross = amount paid");

// ── Cleanup ────────────────────────────────────────────────────────────────
await moloni("/invoices/delete/", { document_id: inv.document_id });
console.log("Cleanup invoice ✓");
console.log("\n=== Shopify→Moloni dry-run passed ===");
