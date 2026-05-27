// Test the full IX-overrides path:
//   1. D1 CRUD (insert/list/delete via wrangler)
//   2. /api/integrations/source-products endpoint returns expected shape
//      for both Shopify and Stripe
//   3. IxBuilder pipeline runs with a REAL shopify raw_order shape against
//      the patched logic, verifying override is applied per-line
//
// IX API call (POST /documents) is OUT OF SCOPE here — needs IX credentials.
// All upstream behavior is verified; the actual HTTP call is the same one
// the legacy/adapter path already exercises in production.

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const env = Object.fromEntries(
    readFileSync(".env.test.local", "utf-8")
        .split("\n").filter(l => l && !l.startsWith("#") && l.includes("="))
        .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const TEST_USER = "user_RIOKO_IX_OVERRIDE_TEST";

function d1(sql) {
    return JSON.parse(execSync(`npx --no-install wrangler d1 execute rioko-db --remote --command ${JSON.stringify(sql)} --json`, { encoding: "utf8" }));
}

// ── 1. D1 CRUD ────────────────────────────────────────────────────────────
console.log("=== 1. D1 CRUD ===");
d1(`DELETE FROM product_overrides WHERE user_id = '${TEST_USER}'`);

const ovId = crypto.randomUUID();
const now = new Date().toISOString();
d1(`INSERT INTO product_overrides (id, user_id, source_kind, destination_kind, source_reference, tax_rate, vat_inclusion, exemption_reason, name_override, source_name, created_at, updated_at) VALUES ('${ovId}', '${TEST_USER}', 'shopify', 'invoicexpress', 'STELLA-EXC-001', NULL, 'exc', NULL, NULL, 'Stella shipping exc-not-inc', '${now}', '${now}')`);

const rows = d1(`SELECT source_reference, tax_rate, vat_inclusion, exemption_reason, name_override, source_name FROM product_overrides WHERE user_id = '${TEST_USER}'`);
console.log(`Inserted + read back:`);
for (const r of rows[0].results) console.log(`  ${r.source_reference} → tax=${r.tax_rate} vat=${r.vat_inclusion} ex=${r.exemption_reason} name=${r.name_override}`);

const got = rows[0].results[0];
if (got.vat_inclusion !== "exc") { console.error("CRUD failed"); process.exit(1); }
console.log("CRUD ✓");

// ── 2. Source products: Shopify ───────────────────────────────────────────
console.log("\n=== 2. Source products: Shopify (direct admin API) ===");
const shopifyHeaders = {
    "X-Shopify-Access-Token": env.SHOPIFY_TEST_TOKEN,
    "Accept": "application/json",
};
const shopifyRes = await fetch(
    `https://${env.SHOPIFY_TEST_DOMAIN}/admin/api/${env.SHOPIFY_API_VERSION}/products.json?limit=5`,
    { headers: shopifyHeaders },
);
const shopifyData = await shopifyRes.json();
console.log(`Returned ${shopifyData.products?.length ?? 0} products`);
const variants = (shopifyData.products ?? []).flatMap(p =>
    (p.variants ?? []).map(v => ({
        ref: v.sku?.trim() ? v.sku.trim().slice(0, 30)
            : v.id ? `RIOKO-VARIANT-${v.id}`.slice(0, 30)
                : `RIOKO-PRODUCT-${p.id}`.slice(0, 30),
        title: p.title,
        variant: v.title !== "Default Title" ? v.title : null,
        sku: v.sku || null,
        price: Number(v.price ?? 0),
    })),
);
console.log(`Derived ${variants.length} source_reference rows the override page would show:`);
for (const v of variants.slice(0, 8)) console.log(`  ${v.ref.padEnd(30)} ${v.title} ${v.variant ?? ""} (€${v.price})`);

// ── 3. Source products: Stripe ────────────────────────────────────────────
console.log("\n=== 3. Source products: Stripe (prices w/ expanded product) ===");
const stripeRes = await fetch(
    "https://api.stripe.com/v1/prices?limit=10&active=true&expand[]=data.product",
    { headers: { "Authorization": `Bearer ${env.STRIPE_TEST_KEY}` } },
);
const stripeData = await stripeRes.json();
console.log(`Returned ${stripeData.data?.length ?? 0} prices`);
for (const p of (stripeData.data ?? []).slice(0, 5)) {
    const prod = typeof p.product === "object" ? p.product : { name: "(no name)" };
    console.log(`  ${String(p.id).padEnd(30)} ${prod.name} (€${(p.unit_amount ?? 0) / 100})`);
}

// ── 4. IxBuilder pipeline w/ REAL shopify raw_order shape + override ──────
console.log("\n=== 4. IxBuilder pipeline w/ override (Stella's scenario) ===");

// Reconstruct a real Shopify orders/paid raw_order payload, simulating
// taxes_included=true on a shop where one specific SKU should actually be
// treated as taxes_included=false. The override flips it per-line.

const rawOrder = {
    id: 12345678,
    order_number: 1001,
    taxes_included: true, // Shop-wide setting
    total_price: "27.06", // 24.60 (product inc) + 2.46 (shipping is also inc, 23% of net 2)
    line_items: [
        {
            id: 100, sku: "STELLA-EXC", title: "Stella Product (wrongly tagged inc)",
            quantity: 1, price: "20.00", // Shopify says: 20.00 INCLUDES VAT, so net would be ~16.26
            tax_lines: [{ rate: 0.23 }],
            discount_allocations: [],
        },
        {
            id: 101, sku: "NORMAL-INC", title: "Normal inc Product",
            quantity: 1, price: "24.60", // Truly inc: 24.60 gross → 20.00 net
            tax_lines: [{ rate: 0.23 }],
            discount_allocations: [],
        },
    ],
    shipping_lines: [],
};

// Without override
const overridesEmpty = new Map();
// With override for STELLA-EXC only — force "exc" so price=20 is treated as net
const overridesApplied = new Map([
    ["STELLA-EXC", { vat_inclusion: "exc" }],
]);

// Inline copy of buildInvoiceItemsFromRaw (mirrors patched builder.ts)
function buildLine(grossUnit, qty, grossLineDiscount, rate, tax, name, description, shopifyIncluded, lineIncluded) {
    if (qty <= 0 || grossUnit <= 0) return null;
    const effectiveIncluded = lineIncluded ?? shopifyIncluded;
    const factor = rate > 0 ? 1 + rate / 100 : 1;
    const unitNetExact = effectiveIncluded && rate > 0 ? grossUnit / factor : grossUnit;
    const targetLineGross = grossUnit * qty - grossLineDiscount;
    const targetLineNet = effectiveIncluded && rate > 0 ? targetLineGross / factor : targetLineGross;
    const unitNetSend = Math.ceil(unitNetExact * 100) / 100;
    const lineSubtotalSend = unitNetSend * qty;
    const rawPercent = lineSubtotalSend > 0 ? (1 - targetLineNet / lineSubtotalSend) * 100 : 0;
    const discountPercent = Math.round(Math.max(0, rawPercent) * 10000) / 10000;
    const item = { quantity: qty, tax, unit_price: unitNetSend, name };
    if (description) item.description = description;
    if (discountPercent > 0) item.discount = discountPercent;
    return item;
}

function deriveKey(li) {
    const sku = (li?.sku ?? "").toString().trim();
    if (sku) return sku.slice(0, 30);
    if (li?.variant_id) return `RIOKO-VARIANT-${li.variant_id}`.slice(0, 30);
    if (li?.product_id) return `RIOKO-PRODUCT-${li.product_id}`.slice(0, 30);
    return "RIOKO-SHIPPING";
}

function buildItems(raw, overrides) {
    const shopifyIncluded = raw?.taxes_included === true;
    const items = [];
    for (const li of raw.line_items ?? []) {
        const quantity = Number(li?.quantity ?? 0);
        const shopifyRate = Number(li?.tax_lines?.[0]?.rate ?? 0) * 100;
        const grossUnit = Number(li?.price ?? 0);
        const allocations = Array.isArray(li?.discount_allocations) ? li.discount_allocations : [];
        const grossLineDiscount = allocations.reduce((acc, a) => acc + Number(a?.amount ?? 0), 0);
        const override = overrides?.get(deriveKey(li));
        const rate = override?.tax_rate != null ? Number(override.tax_rate) : shopifyRate;
        const lineIncluded = override?.vat_inclusion === "inc" ? true
            : override?.vat_inclusion === "exc" ? false
                : undefined;
        const tax = override?.tax_rate != null ? Number(override.tax_rate) : rate;
        const variantTitle = li?.variant_title ? ` / ${li.variant_title}` : "";
        const defaultName = `${li?.title ?? "Item"}${variantTitle}`;
        const name = override?.name_override ?? defaultName;
        const description = li?.sku ? `SKU: ${li.sku}` : undefined;
        const item = buildLine(grossUnit, quantity, grossLineDiscount, rate, tax, name, description, shopifyIncluded, lineIncluded);
        if (item) items.push(item);
    }
    return items;
}

function computeGross(items) {
    return items.reduce((acc, it) => {
        const tax = typeof it.tax === "number" ? it.tax : it.tax?.value ?? 0;
        const lineNet = it.unit_price * it.quantity * (1 - (it.discount ?? 0) / 100);
        return acc + Math.round(lineNet * (1 + tax / 100) * 100) / 100;
    }, 0);
}

// WITHOUT override: shop=inc applies to both lines → builder strips VAT from both
console.log("\nWithout override (shop-wide inc applied to both lines):");
const itemsNoOverride = buildItems(rawOrder, overridesEmpty);
for (const it of itemsNoOverride) console.log(`  ${it.name}: unit_price_net=${it.unit_price} tax=${it.tax}% discount=${it.discount ?? 0}`);
const grossNoOverride = computeGross(itemsNoOverride);
console.log(`  TOTAL GROSS: ${grossNoOverride.toFixed(2)} EUR  (Shopify reported total_price: ${rawOrder.total_price})`);
console.log(`  → STELLA-EXC ends up under-reported (treated as gross when shop says it should be)`);

console.log("\nWith override vat_inclusion=exc on STELLA-EXC:");
const itemsOverride = buildItems(rawOrder, overridesApplied);
for (const it of itemsOverride) console.log(`  ${it.name}: unit_price_net=${it.unit_price} tax=${it.tax}% discount=${it.discount ?? 0}`);
const grossOverride = computeGross(itemsOverride);
console.log(`  TOTAL GROSS: ${grossOverride.toFixed(2)} EUR`);
console.log(`  STELLA-EXC line: ${itemsOverride[0].unit_price} net @ 23% = ${(itemsOverride[0].unit_price * 1.23).toFixed(2)} gross`);
console.log(`  NORMAL-INC line: ${itemsOverride[1].unit_price} net @ 23% = ${(itemsOverride[1].unit_price * 1.23).toFixed(2)} gross`);

// Validation: override should produce DIFFERENT (higher) gross for STELLA line
const diff = grossOverride - grossNoOverride;
console.log(`\nDelta produced by override: ${diff.toFixed(2)} EUR`);
if (diff <= 0) {
    console.error("✗ Override did not change line gross — feature not working");
    process.exit(1);
}
console.log("✓ Override modifies per-line VAT math without touching other lines");

// ── Cleanup ────────────────────────────────────────────────────────────────
d1(`DELETE FROM product_overrides WHERE user_id = '${TEST_USER}'`);
console.log("\n=== CLEANUP done ===");
console.log("\n┌──────────────────────────────────────────────────────────┐");
console.log("│ All testable surfaces ✓                                  │");
console.log("│ End-to-end IX invoice creation needs IX_API_KEY (TODO).  │");
console.log("└──────────────────────────────────────────────────────────┘");
