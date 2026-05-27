// Real end-to-end test against InvoiceXpress sandbox.
// Walks the patched IxBuilder logic for two scenarios that exercise the
// override feature, then POSTs to /v2/documents through the Kapta IX proxy
// and verifies the returned gross total matches expectations.

import { readFileSync } from "node:fs";

const env = Object.fromEntries(
    readFileSync(".env.test.local", "utf-8")
        .split("\n").filter(l => l && !l.startsWith("#") && l.includes("="))
        .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const IX_BASE = "https://ix-proxy.kapta.app";
const IX_HEADERS = {
    "x-account-name": env.IX_ACCOUNT_NAME,
    "x-api-key": env.IX_API_KEY,
    "x-env": env.IX_ENV ?? "dev",
    "Accept": "application/json",
    "Content-Type": "application/json",
};

async function ix(method, path, body) {
    const res = await fetch(`${IX_BASE}${path}`, {
        method,
        headers: IX_HEADERS,
        body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || (json && json.success === false)) {
        throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
    }
    return json;
}

// ── Replicate the patched IxBuilder logic ──────────────────────────────────
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

function buildItemsFromRaw(raw, overrides) {
    const shopifyIncluded = raw?.taxes_included === true;
    const items = [];
    for (const li of (raw.line_items ?? [])) {
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
        const name = (override?.name_override ?? defaultName).slice(0, 200);
        const description = li?.sku ? `SKU: ${li.sku}` : undefined;
        const item = buildLine(grossUnit, quantity, grossLineDiscount, rate, tax, name, description, shopifyIncluded, lineIncluded);
        if (item) items.push(item);
    }
    return items;
}

const results = [];

async function runScenario(label, items, expectedGross, options = {}) {
    console.log(`\n=== ${label} ===`);
    console.log(`  Expected gross: ${expectedGross.toFixed(2)} EUR`);

    const today = new Date().toISOString().slice(0, 10);
    const invoice = {
        date: today,
        due_date: today,
        client: {
            name: "Consumidor Final",
            email: "",
            address: "Desconhecido",
            city: "Desconhecido",
            postal_code: "0000-000",
            country: "PT",
            code: "0",
        },
        items,
        reference: `RIOKO-E2E-${Date.now()}`,
        tax_exemption_reason: options.exemption ?? undefined,
    };

    // IX accepts tax as a plain number; resolver `on_tax_fallback_search_tax_by_value`
    // matches by value to the company's tax catalog.
    invoice.items = invoice.items.map(it => ({
        ...it,
        tax: typeof it.tax === "number" ? it.tax : Number(it.tax?.value ?? 0),
    }));

    const created = await ix("POST", "/v2/documents?resolvers=on_tax_fallback_search_tax_by_value", {
        data: invoice,
        type: options.docType ?? "invoice",
    });

    const inv = created.data?.invoice ?? created.data;
    if (!inv?.id) throw new Error(`No invoice id in response: ${JSON.stringify(created).slice(0, 300)}`);

    const ixTotal = Number(inv.total);
    const ixSum = Number(inv.sum);
    const ixTaxes = Number(inv.taxes);
    const drift = Math.abs(ixTotal - expectedGross);

    console.log(`  IX invoice id=${inv.id} type=${inv.type} status=${inv.status}`);
    console.log(`  IX sum (net): ${ixSum.toFixed(2)} / taxes: ${ixTaxes.toFixed(2)} / total (gross): ${ixTotal.toFixed(2)} EUR`);
    console.log(`  Drift: ${drift.toFixed(4)} EUR`);
    for (const i of inv.items ?? []) {
        console.log(`    "${i.name}" qty=${i.quantity} unit_price=${i.unit_price} tax_rate=${i.tax?.value} subtotal=${i.subtotal} tax_amount=${i.tax_amount}`);
    }

    const pass = drift <= 0.01;
    results.push({ label, pass, drift, ixId: inv.id });

    // Drafts in sandbox aren't fiscal and don't need cleanup; we leave them.
    return pass;
}

// ───────────────────────────────────────────────────────────────────────────
// SCENARIO A: Shopify→IX without override, baseline
// ───────────────────────────────────────────────────────────────────────────
const rawA = {
    id: 11111111, order_number: 1001, taxes_included: true,
    line_items: [
        { id: 1, sku: "RIOKO-T-001", title: "Test Item A", quantity: 1, price: "24.60", tax_lines: [{ rate: 0.23 }], discount_allocations: [] },
    ],
};
await runScenario(
    "A — Shopify shop inc, no override (baseline)",
    buildItemsFromRaw(rawA, new Map()),
    24.60,
);

// ───────────────────────────────────────────────────────────────────────────
// SCENARIO B: Stella case — shop is inc but a specific SKU is actually exc
// ───────────────────────────────────────────────────────────────────────────
const rawB = {
    id: 22222222, order_number: 1002, taxes_included: true,
    line_items: [
        // This product price is 20.00 but Shopify wrongly tagged it as inc.
        // Without override the IX invoice would land at 20.00 gross.
        // With override vat_inclusion=exc the invoice should be 20.00 * 1.23 = 24.60.
        { id: 1, sku: "STELLA-EXC-001", title: "Stella exc-not-inc product", quantity: 1, price: "20.00", tax_lines: [{ rate: 0.23 }], discount_allocations: [] },
    ],
};

console.log("\n--- B.1 baseline (no override): expect under-reporting ---");
await runScenario(
    "B.1 — Stella SKU WITHOUT override (under-reports)",
    buildItemsFromRaw(rawB, new Map()),
    20.00,
);

console.log("\n--- B.2 with vat_inclusion=exc override ---");
await runScenario(
    "B.2 — Stella SKU WITH vat_inclusion=exc override",
    buildItemsFromRaw(rawB, new Map([["STELLA-EXC-001", { vat_inclusion: "exc" }]])),
    24.60,
);

// ───────────────────────────────────────────────────────────────────────────
// SCENARIO C: tax_rate override (23% → 6% for a book)
// ───────────────────────────────────────────────────────────────────────────
const rawC = {
    id: 33333333, order_number: 1003, taxes_included: false,
    line_items: [
        { id: 1, sku: "RIOKO-BOOK-001", title: "Test Book", quantity: 2, price: "10.00", tax_lines: [{ rate: 0.23 }], discount_allocations: [] },
    ],
};
console.log("\n--- C.1 baseline (no override, 23%) ---");
await runScenario(
    "C.1 — Book WITHOUT override (Shopify-reported 23%)",
    buildItemsFromRaw(rawC, new Map()),
    Math.round(10 * 2 * 1.23 * 100) / 100, // 24.60
);

console.log("\n--- C.2 with tax_rate=6 override ---");
await runScenario(
    "C.2 — Book WITH tax_rate=6 override",
    buildItemsFromRaw(rawC, new Map([["RIOKO-BOOK-001", { tax_rate: 6 }]])),
    Math.round(10 * 2 * 1.06 * 100) / 100, // 21.20
);

// ───────────────────────────────────────────────────────────────────────────
// SCENARIO D: Stripe-shape (synthetic single line, tax=0)
// Stripe-source emits product_id=0, variant_id=0, sku=price.id, tax=0.
// Override applies tax_rate=23 to that price.
// ───────────────────────────────────────────────────────────────────────────
const stripePriceId = "price_test_synth_xyz";
const stripeLineItem = {
    quantity: 1,
    name: "Stripe synthetic line",
    description: `SKU: ${stripePriceId}`,
    unit_price: 50.00,
    tax: { name: "VAT", value: 0 }, // Stripe default tax=0
};

console.log("\n--- D.1 baseline (tax=0, no override) ---");
await runScenario(
    "D.1 — Stripe single-line WITHOUT override (tax=0)",
    [stripeLineItem],
    50.00,
    { exemption: "M01" },
);

console.log("\n--- D.2 with tax_rate=23 override (force VAT on Stripe payments) ---");
// Same line but adapter applied override during buildLine
const stripeWithOverride = { ...stripeLineItem, tax: { name: "VAT", value: 23 } };
await runScenario(
    "D.2 — Stripe single-line WITH tax_rate=23 override",
    [stripeWithOverride],
    Math.round(50 * 1.23 * 100) / 100, // 61.50
);

// ── Summary ────────────────────────────────────────────────────────────────
console.log("\n========================================");
console.log("SHOPIFY/STRIPE → INVOICEXPRESS E2E SUMMARY");
console.log("========================================");
for (const r of results) console.log(`  ${r.pass ? "✓" : "✗"}  ${r.label}  (drift=${r.drift.toFixed(4)} EUR, invoice ${r.ixId})`);
const failed = results.filter(r => !r.pass);
if (failed.length > 0) { console.error(`\n${failed.length} FAILED`); process.exit(1); }
console.log(`\n${results.length} scenarios all passed.`);
