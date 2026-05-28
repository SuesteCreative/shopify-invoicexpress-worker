// Real invoice-create test against Moloni Kapta (test account, no ATCUD).
// Verifies that the patched form-encoded body produces a valid Moloni invoice
// AND that the resulting gross total matches our reconcile expectation.

import { readFileSync } from "node:fs";

const env = Object.fromEntries(
    readFileSync(".env.test.local", "utf-8")
        .split("\n")
        .filter(l => l && !l.startsWith("#") && l.includes("="))
        .map(l => {
            const idx = l.indexOf("=");
            return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
        }),
);

function formEncode(obj, prefix = "") {
    const parts = [];
    for (const [k, v] of Object.entries(obj)) {
        if (v === undefined || v === null) continue;
        const key = prefix ? `${prefix}[${k}]` : k;
        if (Array.isArray(v)) {
            v.forEach((item, i) => {
                const idxKey = `${key}[${i}]`;
                if (item !== null && typeof item === "object") {
                    parts.push(formEncode(item, idxKey));
                } else {
                    parts.push(`${encodeURIComponent(idxKey)}=${encodeURIComponent(String(item))}`);
                }
            });
        } else if (typeof v === "object") {
            parts.push(formEncode(v, key));
        } else {
            parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
        }
    }
    return parts.filter(Boolean).join("&");
}

// --- OAuth ---
const oauthUrl = new URL("https://api.moloni.pt/v1/grant/");
oauthUrl.searchParams.set("grant_type", "password");
oauthUrl.searchParams.set("client_id", env.MOLONI_CLIENT_ID);
oauthUrl.searchParams.set("client_secret", env.MOLONI_CLIENT_SECRET);
oauthUrl.searchParams.set("username", env.MOLONI_USERNAME);
oauthUrl.searchParams.set("password", env.MOLONI_PASSWORD);

const SECRET_KEYS = new Set(["access_token", "refresh_token", "client_secret", "password", "api_key"]);
function redact(o) {
    if (!o || typeof o !== "object") return o;
    if (Array.isArray(o)) return o.map(redact);
    const out = {};
    for (const [k, v] of Object.entries(o)) out[k] = SECRET_KEYS.has(k.toLowerCase()) ? (v ? "[REDACTED]" : v) : redact(v);
    return out;
}

const tokenJson = await fetch(oauthUrl, { method: "POST" }).then(r => r.json());
const token = tokenJson.access_token;
if (!token) {
    console.error("OAuth failed:", redact(tokenJson));
    process.exit(1);
}
console.log("OAuth ✓");

async function moloniCall(path, body) {
    const url = `https://api.moloni.pt/v1${path}?access_token=${encodeURIComponent(token)}`;
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
        body: formEncode({ company_id: Number(env.MOLONI_COMPANY_ID), ...body }),
    });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, json };
}

// --- Lookup/create customer (Consumidor Final by NIF 999999990) ---
const lookup = await moloniCall("/customers/getByVat/", { vat: "999999990" });
const customerId = lookup.json?.[0]?.customer_id;
if (!customerId) {
    console.error("Consumidor Final lookup failed:", lookup);
    process.exit(1);
}
console.log(`Customer ✓ id=${customerId}`);

// --- List tax IDs available in this company (we need a real tax_id for 23%) ---
const taxes = await moloniCall("/taxes/getAll/", {});
const tax23 = taxes.json?.find(t => Number(t.value) === 23 && t.type === 1);
if (!tax23) {
    console.error("No 23% tax found:", taxes.json?.slice(0, 3));
    process.exit(1);
}
console.log(`Tax 23% ✓ id=${tax23.tax_id}`);

// --- Build a 2-line invoice that mimics what the adapter would post ---
// Scenario: Shopify order paid 24.60 EUR (gross), 1x product @ 20.00 net + shipping @ 0.00.
// 20.00 * 1.23 = 24.60. Reconcile against 24.60.
const today = new Date().toISOString().slice(0, 10);
const products = [
    {
        name: "Test produto",
        qty: 1,
        price: 20.00, // net
        discount: 0,
        order: 1,
        taxes: [{ tax_id: tax23.tax_id, value: 23, order: 1, cumulative: 0 }],
    },
];

const payload = {
    document_set_id: Number(env.MOLONI_DOCUMENT_SET_ID),
    customer_id: customerId,
    date: today,
    expiration_date: today,
    our_reference: `RIOKO-TEST-${Date.now()}`,
    products,
    status: 0, // 0 = draft
    notes: "Rioko adapter smoke test — safe to delete",
};

console.log("Insert payload (form-encoded preview):");
console.log("  " + formEncode(payload).slice(0, 200) + "...");

const result = await moloniCall("/invoices/insert/", payload);
console.log("Insert response status:", result.status);
console.log("Insert response JSON:", JSON.stringify(result.json, null, 2).slice(0, 1500));

if (!result.ok || !result.json?.document_id) {
    console.error("✗ Insert FAILED");
    process.exit(1);
}

const docId = result.json.document_id;
console.log(`Invoice ✓ document_id=${docId}`);

// --- Verify computed gross matches what we expected ---
const fetched = await moloniCall("/invoices/getOne/", { document_id: docId });
const grossFromMoloni = Number(fetched.json?.gross_value ?? fetched.json?.total ?? 0);
const expected = 24.60;
const drift = Math.abs(grossFromMoloni - expected);
console.log(`Expected gross: ${expected.toFixed(2)} EUR`);
console.log(`Moloni gross:   ${grossFromMoloni.toFixed(2)} EUR`);
console.log(`Drift:          ${drift.toFixed(4)} EUR`);
if (drift > 0.01) {
    console.error("✗ DRIFT > 1¢ — adapter would reject this in createDraft");
    process.exit(1);
} else {
    console.log("✓ Reconcile would pass (drift within tolerance)");
}

// --- Cleanup: delete the draft ---
const del = await moloniCall("/invoices/delete/", { document_id: docId });
console.log("Cleanup delete:", del.ok ? "✓" : `✗ ${JSON.stringify(del.json).slice(0, 150)}`);
