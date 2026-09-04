#!/usr/bin/env node
/**
 * "Can we tell these payments apart?"
 *
 * A merchant collects money through several systems into one Stripe account — a
 * booking plugin, Payment Links, invoices marked as paid outside Stripe — and
 * wants each stream filed in its own document series. Whether that is possible
 * is not a design question: it depends on what the systems actually write onto
 * the payment. This answers it from the live account, before anything is
 * configured.
 *
 * For every payment in the window it resolves the SAME candidate strings the
 * worker matches routing rules against (Stripe metadata as `key` / `key:value`,
 * plus the `stripe:` hints from `buildStripeRoutingHints`), groups the payments
 * by the fingerprint they share, and — given a proposed rule — reports exactly
 * which payments it would catch and which it would miss.
 *
 *   node scripts/stripe-origins.mjs --key rk_live_… [--days 90] [--limit 100]
 *   node scripts/stripe-origins.mjs --key rk_live_… --match stripe:origin:api
 *   node scripts/stripe-origins.mjs --key rk_live_… --match "stripe:origin:api + stripe:amount:45.00"
 *
 * The key may also come from STRIPE_KEY in the environment. A read-only
 * restricted key is enough (Charges, PaymentIntents, Checkout Sessions,
 * Invoices — all Read). Nothing here writes to Stripe.
 *
 * Mirrors `buildStripeRoutingHints` in src/adapters/sources/stripe-source.ts.
 * If the hints there change, change them here.
 */

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const KEY = argOf("--key", process.env.STRIPE_KEY);
const DAYS = Number(argOf("--days", "90"));
const LIMIT = Number(argOf("--limit", "100"));
const MATCH = argOf("--match", null);

if (!KEY) {
  console.error("Missing Stripe key. Pass --key rk_live_… or set STRIPE_KEY.");
  process.exit(1);
}

const API = "https://api.stripe.com/v1";

async function get(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${KEY}`, "Stripe-Version": "2024-12-18.acacia" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${path.split("?")[0]}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

/** The `stripe:` hints, exactly as the worker builds them. */
function buildHints(objects, origin, money) {
  const hints = new Set();
  const add = (name, value) => {
    const v = String(value ?? "").trim().toLowerCase().slice(0, 120);
    if (v) hints.add(`stripe:${name}:${v}`);
  };
  if (origin) add("origin", origin);
  for (const obj of objects) {
    if (!obj || typeof obj !== "object") continue;
    add("payment_method", obj.payment_method_details?.type);
    for (const t of Array.isArray(obj.payment_method_types) ? obj.payment_method_types : []) {
      add("payment_method", t);
    }
    add("description", obj.description);
    add("statement", obj.statement_descriptor ?? obj.statement_descriptor_suffix);
    if (typeof obj.application === "string") add("application", obj.application);
    add("mode", obj.mode);
    add("billing_reason", obj.billing_reason);
    if (obj.paid_out_of_band === true) hints.add("stripe:paid_out_of_band");
  }
  if (money && Number.isFinite(money.total) && money.total > 0) {
    const amount = money.total.toFixed(2);
    add("amount", amount);
    if (money.currency) add("amount", `${money.currency}:${amount}`);
  }
  return [...hints];
}

/** The metadata candidates: `key` and `key:value`, as matchTagRouting sees them. */
function metadataCandidates(objects) {
  const out = new Set();
  for (const obj of objects) {
    const md = obj?.metadata;
    if (!md || typeof md !== "object") continue;
    for (const [k, v] of Object.entries(md)) {
      const name = String(k).trim();
      if (!name) continue;
      out.add(name);
      const value = String(v ?? "").trim();
      if (value) out.add(`${name}:${value}`);
    }
  }
  return [...out];
}

const since = Math.floor(Date.now() / 1000) - DAYS * 86400;

console.log(`Reading up to ${LIMIT} payments from the last ${DAYS} days…`);

// Charges are the one shape every settled payment has, whatever created it.
// `payment_intent` is expanded because the plugin that created the sale usually
// wrote its metadata and description there rather than on the charge.
const charges = [];
let startingAfter = null;
while (charges.length < LIMIT) {
  const page = await get(
    `/charges?limit=${Math.min(100, LIMIT - charges.length)}&created[gte]=${since}`
    + `&expand[]=data.payment_intent${startingAfter ? `&starting_after=${startingAfter}` : ""}`,
  );
  charges.push(...(page.data ?? []));
  if (!page.has_more || !page.data?.length) break;
  startingAfter = page.data[page.data.length - 1].id;
}

// Invoices marked as paid outside Stripe never produce a charge, so the charge
// list alone would hide the merchant's "marked as paid" stream entirely.
const oobInvoices = (await get(`/invoices?limit=100&status=paid&created[gte]=${since}`))
  .data?.filter(inv => inv.paid_out_of_band === true) ?? [];

const rows = [];

for (const ch of charges) {
  const pi = typeof ch.payment_intent === "object" ? ch.payment_intent : null;
  const piId = pi?.id ?? (typeof ch.payment_intent === "string" ? ch.payment_intent : null);

  let invoice = null;
  if (ch.invoice) invoice = await get(`/invoices/${ch.invoice}`).catch(() => null);

  let session = null;
  if (!invoice && piId) {
    const list = await get(`/checkout/sessions?payment_intent=${piId}&limit=1`).catch(() => null);
    session = list?.data?.[0] ?? null;
  }

  const origin = invoice ? "invoice" : session ? "checkout" : "api";
  const objects = [ch, pi, session, invoice].filter(Boolean);

  rows.push({
    id: piId ?? ch.id,
    when: new Date((ch.created ?? 0) * 1000).toISOString().slice(0, 10),
    amount: `${((ch.amount ?? 0) / 100).toFixed(2)} ${String(ch.currency ?? "").toUpperCase()}`,
    origin,
    candidates: [
      ...buildHints(objects, origin, { total: (ch.amount ?? 0) / 100, currency: ch.currency }),
      ...metadataCandidates(objects),
    ],
  });
}

for (const inv of oobInvoices) {
  rows.push({
    id: inv.id,
    when: new Date((inv.status_transitions?.paid_at ?? inv.created ?? 0) * 1000).toISOString().slice(0, 10),
    amount: `${((inv.amount_paid ?? inv.total ?? 0) / 100).toFixed(2)} ${String(inv.currency ?? "").toUpperCase()}`,
    origin: "invoice",
    candidates: [
      ...buildHints([inv], "invoice", { total: (inv.amount_paid ?? inv.total ?? 0) / 100, currency: inv.currency }),
      ...metadataCandidates([inv]),
    ],
  });
}

rows.sort((a, b) => (a.when < b.when ? 1 : -1));

if (rows.length === 0) {
  console.log("No payments in the window. Widen --days.");
  process.exit(0);
}

// ── what the streams look like ───────────────────────────────────────────────
// Group on the candidates that describe the SOURCE of a payment rather than the
// individual sale: two bookings differ by buyer and amount but come from the
// same system, and it is the system we are trying to separate.
const groups = new Map();
for (const row of rows) {
  const shape = row.candidates
    .filter(c => c.startsWith("stripe:origin:") || c.startsWith("stripe:description:")
      || c.startsWith("stripe:application:") || c === "stripe:paid_out_of_band"
      || (!c.startsWith("stripe:") && !c.includes(":")))
    .sort()
    .join("  ");
  const g = groups.get(shape) ?? { count: 0, sample: row, total: 0 };
  g.count += 1;
  g.total += Number.parseFloat(row.amount) || 0;
  groups.set(shape, g);
}

console.log(`\n${rows.length} payments, ${groups.size} distinct shapes:\n`);
for (const [shape, g] of [...groups.entries()].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`  ${String(g.count).padStart(4)} payments, ${g.total.toFixed(2)} — ${shape || "(nothing to match on)"}`);
  console.log(`         e.g. ${g.sample.id}  ${g.sample.when}  ${g.sample.amount}`);
  console.log(`         all candidates: ${g.sample.candidates.join(", ") || "(none)"}`);
}

// ── every candidate, by how many payments carry it ───────────────────────────
const freq = new Map();
for (const row of rows) for (const c of row.candidates) freq.set(c, (freq.get(c) ?? 0) + 1);

console.log(`\nCandidate strings a routing rule could be written against:\n`);
for (const [c, n] of [...freq.entries()].sort((a, b) => b[1] - a[1])) {
  const share = ((n / rows.length) * 100).toFixed(0);
  // A candidate on every payment separates nothing; one on a single payment is
  // probably that sale's own reference, not its stream.
  const note = n === rows.length ? "  ← on every payment, separates nothing" : n === 1 ? "  ← unique to one sale" : "";
  console.log(`  ${String(n).padStart(4)} (${share.padStart(3)}%)  ${c}${note}`);
}

// ── prices that repeat ───────────────────────────────────────────────────────
// Software selling a fixed catalogue charges the same few amounts over and over.
// A handful of amounts carrying most of the payments is that catalogue; a long
// tail of amounts appearing once each is money collected by hand.
const byAmount = new Map();
for (const row of rows) {
  const amount = row.candidates.find(c => c.startsWith("stripe:amount:") && !c.split(":")[2]?.match(/^[a-z]{3}$/));
  if (!amount) continue;
  const g = byAmount.get(amount) ?? { count: 0, origins: new Set() };
  g.count += 1;
  g.origins.add(row.origin);
  byAmount.set(amount, g);
}
const repeated = [...byAmount.entries()].filter(([, g]) => g.count > 1).sort((a, b) => b[1].count - a[1].count);
if (repeated.length) {
  console.log(`
Prices charged more than once — a fixed catalogue looks like this:
`);
  for (const [amount, g] of repeated) {
    // An amount charged from two different surfaces is not a clean
    // discriminator on its own: pair it with the origin in the rule name.
    const mixed = g.origins.size > 1 ? `  ← also charged from ${[...g.origins].join(" + ")}, pair it with the origin` : "";
    console.log(`  ${String(g.count).padStart(4)} × ${amount}   (${[...g.origins].join(", ")})${mixed}`);
  }
}

// ── would this rule do what we want? ─────────────────────────────────────────
if (MATCH) {
  // Same conjunction the worker matches on: `a + b` needs both.
  const parts = MATCH.includes(" + ") ? MATCH.split(" + ").map(p => p.trim()).filter(Boolean) : [MATCH];
  const hit = rows.filter(r => parts.every(p => r.candidates.includes(p)));
  console.log(`\nA rule named "${MATCH}" would catch ${hit.length} of ${rows.length} payments:\n`);
  for (const r of hit.slice(0, 30)) console.log(`  ✓ ${r.id}  ${r.when}  ${r.amount}  (${r.origin})`);
  if (hit.length > 30) console.log(`  … and ${hit.length - 30} more`);
  const missed = rows.filter(r => !parts.every(p => r.candidates.includes(p)));
  console.log(`\nAnd would leave ${missed.length} to the connection's own series:\n`);
  for (const r of missed.slice(0, 30)) console.log(`  · ${r.id}  ${r.when}  ${r.amount}  (${r.origin})`);
  if (missed.length > 30) console.log(`  … and ${missed.length - 30} more`);
}
