// End-to-end Moloni test: replicates the patched adapter flow.
// 1) OAuth   2) find-or-create placeholder product   3) lookup customer
// 4) build line items   5) insert invoice   6) verify gross   7) cleanup

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

// === 1. Placeholder product (find-or-create) ===
const PLACEHOLDER_REF = "RIOKO-PLACEHOLDER";
const DEFAULT_TAX_ID = 3476562;
let placeholderPid;
const lookup = await call("/products/getByReference/", { reference: PLACEHOLDER_REF });
if (Array.isArray(lookup) && lookup[0]?.product_id) {
    placeholderPid = lookup[0].product_id;
    console.log(`Placeholder ✓ existing product_id=${placeholderPid}`);
} else {
    const cats = await call("/productCategories/getAll/", { parent_id: 0 });
    const categoryId = cats[0]?.category_id;
    const units = await call("/measurementUnits/getAll/", {});
    const unitId = units[0]?.unit_id;
    const created = await call("/products/insert/", {
        category_id: categoryId, unit_id: unitId, type: 1,
        name: "Rioko Order Line", reference: PLACEHOLDER_REF,
        price: 0, has_stock: 0,
        taxes: [{ tax_id: DEFAULT_TAX_ID, value: 23, order: 0, cumulative: 0 }],
    });
    placeholderPid = created.product_id;
    console.log(`Placeholder ✓ created product_id=${placeholderPid}`);
}

// === 2. Customer (Consumidor Final) ===
const customers = await call("/customers/getByVat/", { vat: "999999990" });
const customerId = customers[0]?.customer_id;
console.log(`Customer ✓ id=${customerId}`);

// === 3. Build a 2-line invoice that mimics what adapter would post ===
// Scenario: Shopify order paid 36.90 EUR (gross), 1x prod @ 20.00 net (24.60 gross) + 1x shipping @ 10.00 net (12.30 gross). Total 36.90.
const today = new Date().toISOString().slice(0, 10);
const products = [
    {
        product_id: placeholderPid,
        name: "Test Item A",
        summary: "SKU: TEST-A",
        qty: 1,
        price: 20.00,
        discount: 0,
        order: 1,
        taxes: [{ tax_id: DEFAULT_TAX_ID, value: 23, order: 1, cumulative: 0 }],
    },
    {
        product_id: placeholderPid,
        name: "Portes de envio — Test Shipping",
        qty: 1,
        price: 10.00,
        discount: 0,
        order: 2,
        taxes: [{ tax_id: DEFAULT_TAX_ID, value: 23, order: 1, cumulative: 0 }],
    },
];

const expectedGross = 24.60 + 12.30;
console.log(`Expected gross: ${expectedGross.toFixed(2)} EUR`);

const inv = await call("/invoices/insert/", {
    document_set_id: DOC_SET,
    customer_id: customerId,
    date: today,
    expiration_date: today,
    our_reference: `RIOKO-E2E-${Date.now()}`,
    products,
    status: 0,
    notes: "Rioko e2e smoke test — safe to delete",
});
console.log(`Invoice ✓ document_id=${inv.document_id}`);

// === 4. Verify totals ===
const got = await call("/invoices/getOne/", { document_id: inv.document_id });
// Reminder: Moloni's gross_value=net (before tax), net_value=gross (with tax)
const moloniGross = Number(got.net_value);
const drift = Math.abs(moloniGross - expectedGross);
console.log(`Moloni net_value (real gross): ${moloniGross.toFixed(2)} EUR`);
console.log(`Drift: ${drift.toFixed(4)} EUR`);
if (drift > 0.01) {
    console.error("✗ DRIFT > 1¢");
    process.exit(1);
} else {
    console.log("✓ Reconcile passes (drift within tolerance)");
}

// === 5. Cleanup ===
await call("/invoices/delete/", { document_id: inv.document_id });
console.log("Cleanup invoice ✓");
// NOTE: leave placeholder product behind — adapter will reuse it on next invoice
