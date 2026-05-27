// Smoke-test the patched Moloni adapter's formEncode + moloniCall against the
// live API. Reads creds from .env.test.local. READ-ONLY operations (getByVat,
// documentSets) — no invoice insert without explicit confirmation.

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

// Reimplement formEncode to mirror the patched moloniCall.
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

const tokenRes = await fetch(oauthUrl, { method: "POST" });
const tokenJson = await tokenRes.json();
const token = tokenJson.access_token;
console.log("OAuth →", tokenRes.status, token ? "✓ token acquired" : "✗ FAIL");

// --- moloniCall replica (form-encoded) ---
async function moloniCall(path, body) {
    const url = `https://api.moloni.pt/v1${path}?access_token=${encodeURIComponent(token)}`;
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
        body: formEncode({ company_id: 325546, ...body }),
    });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, json };
}

// --- Test 1: simple lookup ---
const lookup = await moloniCall("/customers/getByVat/", { vat: "999999990" });
console.log("getByVat →", lookup.status, lookup.ok && Array.isArray(lookup.json) && lookup.json[0]?.name === "Consumidor Final" ? "✓ found Consumidor Final" : `✗ ${JSON.stringify(lookup.json).slice(0, 200)}`);

// --- Test 2: documentSets (no nested) ---
const sets = await moloniCall("/documentSets/getAll/", {});
console.log("documentSets →", sets.status, Array.isArray(sets.json) ? `✓ ${sets.json.length} sets, first=${sets.json[0]?.document_set_id}` : `✗ ${JSON.stringify(sets.json).slice(0, 200)}`);

// --- Test 3: nested products array (the hard case) ---
// Use a dry-run-ish endpoint that takes nested arrays. /products/getAll/ accepts a deep filter.
const products = await moloniCall("/products/getAll/", { qty: 1, offset: 0 });
console.log("products/getAll →", products.status, Array.isArray(products.json) ? `✓ ${products.json.length} products` : `(no products set up — ${JSON.stringify(products.json).slice(0, 150)})`);

// --- Test 4: invoice payload shape (DRY-RUN check via /documents/getAll with nested filters) ---
const docs = await moloniCall("/documents/getAll/", {
    document_set_id: 797182,
    documents_type: ["FT", "FR"],  // nested array
});
console.log("documents/getAll →", docs.status, Array.isArray(docs.json) ? `✓ ${docs.json.length} docs` : `${JSON.stringify(docs.json).slice(0, 200)}`);
