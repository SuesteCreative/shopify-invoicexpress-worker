#!/usr/bin/env node
/**
 * "Is the buyer's identity even IN Stripe?"
 *
 * When a merchant says the NIFs, phone numbers and addresses did not make it
 * into their invoicing software, there are only two possible answers and they
 * lead opposite ways: either the data is on the Stripe Customer and we are
 * dropping it, or it was never written and no integration can invent it. This
 * counts, for every Customer on an account, which of the fields the invoice
 * builder reads are actually populated.
 *
 * Reads the SAME fields `buildInvoiceClient` does: name, email, tax_ids (the
 * NIF), address (line1/city/postal_code/country) and phone — plus the metadata
 * keys the account happens to carry, because a source system that writes the
 * NIF somewhere non-standard usually writes it there.
 *
 *   node scripts/stripe-identity-coverage.mjs --key sk_live_… [--account acct_…]
 *   node scripts/stripe-identity-coverage.mjs --key sk_live_… --account acct_… --json out.json
 *
 * `--account` is required for a Stripe Connect merchant: we hold no key of
 * theirs, only their acct_…, and the platform key must be scoped with it. The
 * key may also come from STRIPE_KEY in the environment. Nothing here writes.
 */

const argv = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const KEY = argOf("--key", process.env.STRIPE_KEY);
const ACCOUNT = argOf("--account", process.env.STRIPE_ACCOUNT);
const JSON_OUT = argOf("--json");
const MAX = Number(argOf("--max", "1000"));

if (!KEY) {
  console.error("Missing --key (or STRIPE_KEY). A read-only key is enough.");
  process.exit(1);
}

async function sget(path, params = {}) {
  const q = new URLSearchParams(params);
  const headers = { Authorization: `Bearer ${KEY}` };
  if (ACCOUNT) headers["Stripe-Account"] = ACCOUNT;
  const res = await fetch(`https://api.stripe.com/v1/${path}?${q}`, { headers });
  const body = await res.json();
  if (!res.ok) throw new Error(`${path} ${res.status}: ${body?.error?.message ?? ""}`);
  return body;
}

const has = (v) => !!(v && String(v).trim());

// `tax_ids` is a sub-list, not a field: it only comes back on a Customer when
// asked for. Expanding it on the LIST is what makes this one pass instead of
// one round-trip per customer.
const customers = [];
let after = null;
while (customers.length < MAX) {
  const params = { limit: "100", "expand[]": "data.tax_ids" };
  if (after) params.starting_after = after;
  const page = await sget("customers", params);
  customers.push(...page.data);
  if (!page.has_more || page.data.length === 0) break;
  after = page.data.at(-1).id;
}

const metadataKeys = {};
for (const c of customers) {
  for (const k of Object.keys(c.metadata ?? {})) metadataKeys[k] = (metadataKeys[k] ?? 0) + 1;
}

const field = (fn) => customers.filter(fn).length;
const coverage = {
  customers: customers.length,
  name: field(c => has(c.name)),
  email: field(c => has(c.email)),
  phone: field(c => has(c.phone)),
  tax_id: field(c => (c.tax_ids?.data ?? []).length > 0),
  address_line1: field(c => has(c.address?.line1)),
  address_city: field(c => has(c.address?.city)),
  address_postal_code: field(c => has(c.address?.postal_code)),
  address_country: field(c => has(c.address?.country)),
  shipping_address: field(c => has(c.shipping?.address?.line1)),
};

const pct = (n) => customers.length ? `${((n / customers.length) * 100).toFixed(0)}%` : "—";
console.log(`\nAccount: ${ACCOUNT ?? "(platform's own)"}`);
console.log(`Customers: ${coverage.customers}\n`);
for (const [k, n] of Object.entries(coverage)) {
  if (k === "customers") continue;
  console.log(`  ${k.padEnd(22)} ${String(n).padStart(5)}  ${pct(n).padStart(5)}`);
}

// The tax ids themselves: which TYPE they were filed under decides whether the
// builder reads them as a NIF at all (pt_nif / eu_vat) or ignores them.
const byType = {};
for (const c of customers) {
  for (const t of c.tax_ids?.data ?? []) byType[t.type] = (byType[t.type] ?? 0) + 1;
}
if (Object.keys(byType).length) {
  console.log("\n  tax_id types:", Object.entries(byType).map(([t, n]) => `${t}=${n}`).join(", "));
} else {
  console.log("\n  tax_id types: none — no Customer on this account carries a tax id.");
}

const metaSorted = Object.entries(metadataKeys).sort((a, b) => b[1] - a[1]).slice(0, 15);
if (metaSorted.length) {
  console.log("\n  metadata keys (a source system that writes the NIF off-spec puts it here):");
  for (const [k, n] of metaSorted) console.log(`    ${k.padEnd(30)} ${String(n).padStart(5)}`);
}

if (JSON_OUT) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(JSON_OUT, JSON.stringify({ account: ACCOUNT, coverage, taxIdTypes: byType, metadataKeys }, null, 2));
  console.log(`\nWrote ${JSON_OUT}`);
}
