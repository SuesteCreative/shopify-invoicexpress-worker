#!/usr/bin/env node
/**
 * Does Stripe hold the catalogue we think it holds?
 *
 * WHY IT EXISTS: this Stripe account is shared with another billing system that
 * creates a product per subscription, so ours sit among ~490 objects that look
 * nothing like them. In that noise, `stripe-ix-*` and `stripe-moloni-*` sat at
 * 5 €/50 € instead of 7,50 €/75 € for months and the admin panel called them
 * "ok", because nothing compared the amount. Five more pairs had a guided page
 * and no price at all. Neither fails loudly: the first sells at the wrong
 * price, the second is never billed.
 *
 * READ-ONLY. Safe to run any time, by anyone, including an agent.
 *
 *   npm run audit:prices              # the matrix, and a non-zero exit if it is wrong
 *   npm run audit:prices -- --json    # the same as JSON
 *
 * Reads KAPTA_STRIPE_RK (or STRIPE_SECRET_KEY) from backoffice/.env.local. The
 * expected side comes from the same module the checkout reads, bundled by
 * `npm run gen:catalogue` — restating it here is how the two drift apart.
 */
import { readFileSync } from "node:fs";
import {
    requiredPrices, statusOf, seatStatusOf, PRODUCT_TAX_CODE, SEAT_PRICE_LOOKUP, SEAT_PRICE_CENTS,
} from "./.gen/price-catalogue.mjs";

const asJson = process.argv.includes("--json");

// ── credentials ──────────────────────────────────────────────────────────────
const env = {};
for (const line of readFileSync("backoffice/.env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const KEY = env.KAPTA_STRIPE_RK || env.STRIPE_SECRET_KEY;
if (!KEY) {
    console.error("Missing KAPTA_STRIPE_RK / STRIPE_SECRET_KEY in backoffice/.env.local");
    process.exit(1);
}
if (!KEY.includes("_live_")) {
    console.error(`Refusing: that key is not a live key. The catalogue this checks is the live one.`);
    process.exit(1);
}

async function stripe(path) {
    const r = await fetch(`https://api.stripe.com/v1/${path}`, { headers: { Authorization: `Bearer ${KEY}` } });
    const j = await r.json();
    if (j.error) throw new Error(`${path}: ${j.error.message}`);
    return j;
}
async function all(path) {
    const out = [];
    let after = null;
    for (let page = 0; page < 20; page++) {
        const j = await stripe(`${path}${path.includes("?") ? "&" : "?"}limit=100${after ? `&starting_after=${after}` : ""}`);
        out.push(...j.data);
        if (!j.has_more) break;
        after = j.data.at(-1).id;
    }
    return out;
}

// ── what Stripe holds ────────────────────────────────────────────────────────
const prices = await all("prices?active=true&expand[]=data.product");
const byKey = new Map();
for (const p of prices) if (p.lookup_key) byKey.set(p.lookup_key, p);

// ── what it should hold ──────────────────────────────────────────────────────
const rows = requiredPrices().map((req) => {
    const price = req.lookup ? byKey.get(req.lookup) : null;
    const product = price && typeof price.product === "object" ? price.product : null;
    return {
        pair: req.connectionKey,
        plan: req.plan,
        lookup: req.lookup,
        status: statusOf(req, price),
        price_id: price?.id ?? null,
        cents: price?.unit_amount ?? null,
        expected_cents: req.amountCents,
        interval: price?.recurring?.interval ?? null,
        tax_behavior: price?.tax_behavior ?? null,
        product: product?.name ?? null,
        product_tax_code: product?.tax_code ?? null,
        product_images: product?.images?.length ?? 0,
        tagged: product?.metadata?.app === "rioko",
    };
});

// The seat is not a pair, so it is in no catalogue row — and was in no check
// at all. A merchant only found out it had gone when unlock answered 500.
const seatPrice = byKey.get(SEAT_PRICE_LOOKUP);
const seat = {
    pair: "—",
    plan: "avulso",
    lookup: SEAT_PRICE_LOOKUP,
    status: seatStatusOf(seatPrice),
    price_id: seatPrice?.id ?? null,
    cents: seatPrice?.unit_amount ?? null,
    expected_cents: SEAT_PRICE_CENTS,
    interval: seatPrice?.recurring?.interval ?? null,
    tax_behavior: seatPrice?.tax_behavior ?? null,
    product: (typeof seatPrice?.product === "object" ? seatPrice.product.name : null) ?? null,
    product_tax_code: (typeof seatPrice?.product === "object" ? seatPrice.product.tax_code : null) ?? null,
    product_images: (typeof seatPrice?.product === "object" ? seatPrice.product.images?.length : 0) ?? 0,
    tagged: (typeof seatPrice?.product === "object" ? seatPrice.product.metadata?.app : null) === "rioko",
};
rows.push(seat);

const bad = rows.filter((r) => r.status !== "ok");
const untagged = rows.filter((r) => r.status === "ok" && !r.tagged);
const noImage = rows.filter((r) => r.status === "ok" && r.product_images === 0);
const noTaxCode = rows.filter((r) => r.status === "ok" && r.product_tax_code !== PRODUCT_TAX_CODE);
const notExclusive = rows.filter((r) => r.status === "ok" && r.tax_behavior !== "exclusive");

if (asJson) {
    console.log(JSON.stringify({ rows, bad: bad.length, untagged: untagged.length }, null, 2));
} else {
    const eur = (c) => (c == null ? "—" : `${(c / 100).toFixed(2).replace(".", ",")} €`);
    console.log(`\nCatálogo de preços — ${rows.length} entradas, ${prices.length} preços activos na conta\n`);
    for (const r of rows) {
        const flag = r.status === "ok" ? "  " : "!!";
        console.log([
            flag,
            (r.lookup ?? "—").padEnd(38),
            eur(r.cents).padStart(10),
            r.status === "wrong_amount" ? `≠ ${eur(r.expected_cents)}`.padEnd(12) : "".padEnd(12),
            r.status.padEnd(13),
            r.tagged ? "" : "sem metadata.app ",
            r.product ?? "",
        ].join(" "));
    }
    const note = (label, list) => { if (list.length) console.log(`\n${label}: ${list.map((r) => r.lookup).join(", ")}`); };
    note("POR CORRIGIR", bad);
    note("produto sem metadata.app=rioko", untagged);
    note("produto sem imagem", noImage);
    note("produto sem tax_code", noTaxCode);
    note("preço não exclusive (IVA)", notExclusive);
    console.log(bad.length ? `\n${bad.length} entrada(s) por corrigir.\n` : "\nCatálogo alinhado.\n");
}

process.exit(bad.length ? 1 : 0);
