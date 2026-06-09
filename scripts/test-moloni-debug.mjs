// Diagnose Moloni invoice insert. Try variants until we get back a document_id.

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

async function call(path, body) {
    const url = `https://api.moloni.pt/v1${path}?access_token=${encodeURIComponent(token)}`;
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
        body: formEncode({ company_id: Number(env.MOLONI_COMPANY_ID), ...body }),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
}

// 1) Inspect an existing invoice to learn the schema for products
const list = await call("/invoices/getAll/", { document_set_id: Number(env.MOLONI_DOCUMENT_SET_ID), qty: 2 });
console.log("getAll first invoice keys:", list.json?.[0] ? Object.keys(list.json[0]) : "empty");
if (list.json?.[0]) {
    console.log("First invoice document_id:", list.json[0].document_id);
    console.log("First invoice products:", JSON.stringify(list.json[0].products, null, 2)?.slice(0, 800));
}

// 2) Try insert with product_id=0 (ad-hoc product, Moloni convention)
const today = new Date().toISOString().slice(0, 10);
const payload = {
    document_set_id: Number(env.MOLONI_DOCUMENT_SET_ID),
    customer_id: 145345502,
    date: today,
    expiration_date: today,
    our_reference: `RIOKO-TEST-${Date.now()}`,
    products: [{
        product_id: 0,
        name: "Test produto",
        qty: 1,
        price: 20.00,
        discount: 0,
        order: 1,
        taxes: [{ tax_id: 3476562, value: 23, order: 1, cumulative: 0 }],
    }],
    status: 0,
    notes: "smoke test",
};

console.log("\n--- Insert with product_id=0 ---");
const insert = await call("/invoices/insert/", payload);
console.log("status:", insert.status);
console.log("json:", JSON.stringify(insert.json, null, 2)?.slice(0, 800));
