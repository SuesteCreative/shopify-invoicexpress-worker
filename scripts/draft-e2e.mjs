// Part B — DRAFT-ONLY end-to-end against the IX SANDBOX (ultramegasonico, x-env=dev).
// Builds each sampled real order with that client's REAL config (bundled real
// IxBuilder), POSTs it as a DRAFT to IX, reads back IX's own computed total/sum/
// taxes, and compares to what the customer actually paid (Shopify total_price).
// Never finalized. Never touches a client production account. Drafts are left in
// the sandbox (non-fiscal). This proves IX accepts our payload shape and agrees
// with our math across real order shapes, and is the regression harness for fixes.
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { IxBuilder } from "./.gen/builder.mjs";

const env = Object.fromEntries(readFileSync(".env.test.local", "utf-8").split("\n")
  .filter(l => l && !l.startsWith("#") && l.includes("=")).map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const IX = "https://ix-proxy.kapta.app";
const H = { "x-account-name": env.IX_ACCOUNT_NAME, "x-api-key": env.IX_API_KEY, "x-env": "dev", "Accept": "application/json", "Content-Type": "application/json" };

const wq = (sql) => { const raw = execSync(`npx wrangler d1 execute rioko-db --remote --json --command "${sql}"`, { encoding: "utf8", maxBuffer: 64e6 }); return JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1))[0].results; };

// Sandbox tax catalog, for forced-tax explicit resolution (mirrors create-invoice.ts).
let SANDBOX_TAXES = [];
async function loadTaxes() { const r = await fetch(`${IX}/v2/taxes`, { headers: H }); const j = await r.json(); SANDBOX_TAXES = j?.data?.taxes ?? []; }
function explicitForRate(rate) { const m = SANDBOX_TAXES.find(t => Number(t.value) === Number(rate)); return m ? { id: Number(m.id), name: String(m.name), value: Number(m.value) } : null; }

function loadConfig(dom) {
  const r = wq(`SELECT user_id, shopify_domain, shopify_token, shopify_api_version, ix_document_type, ix_exemption_reason, ix_b2b_exemption_reason, force_tax_rate, force_shipping_tax_rate, vat_included, oss_enabled, b2b_reverse_charge, pos_mode, ix_retention_enabled, ix_retention FROM integrations WHERE shopify_domain='${dom}'`)[0];
  for (const k of ["force_tax_rate", "force_shipping_tax_rate", "vat_included", "oss_enabled", "b2b_reverse_charge", "pos_mode", "ix_retention_enabled", "ix_retention"]) r[k] = r[k] == null ? null : Number(r[k]);
  return r;
}
async function fetchByNumbers(cfg, nums) {
  const ver = cfg.shopify_api_version || "2026-01";
  const out = [];
  for (const n of nums) {
    const res = await fetch(`https://${cfg.shopify_domain}/admin/api/${ver}/orders.json?name=${n}&status=any&limit=1`, { headers: { "X-Shopify-Access-Token": cfg.shopify_token, "Accept": "application/json" } });
    const o = (await res.json()).orders?.[0]; if (o) out.push(o);
  }
  return out;
}
async function fetchRecent(cfg, n = 80) {
  const ver = cfg.shopify_api_version || "2026-01";
  const res = await fetch(`https://${cfg.shopify_domain}/admin/api/${ver}/orders.json?status=any&financial_status=paid&limit=${n}`, { headers: { "X-Shopify-Access-Token": cfg.shopify_token, "Accept": "application/json" } });
  return (await res.json()).orders ?? [];
}
function toNormalized(raw) {
  return { order: { id: raw.id, order_number: raw.order_number, created_at: raw.created_at, customer: raw.customer ?? {}, billing_address: raw.billing_address ?? {}, shipping_address: raw.shipping_address ?? {}, note: raw.note ?? null, note_attributes: raw.note_attributes ?? [], items: [] }, raw_order: raw };
}
// Pick representative samples from recent orders.
function pickSamples(orders) {
  const pos = (o) => Number(o.total_price) > 0;
  const foreign = orders.find(o => pos(o) && String(o.billing_address?.country_code ?? "").toUpperCase() !== "PT" && o.billing_address?.country_code);
  const disc = orders.find(o => pos(o) && (Number(o.total_discounts) > 0 || (o.line_items ?? []).some(li => (li.discount_allocations ?? []).length)));
  const multi = orders.find(o => pos(o) && (o.line_items ?? []).filter(li => Number(li.price) > 0).length >= 4);
  const pt = orders.find(o => pos(o) && String(o.billing_address?.country_code ?? "").toUpperCase() === "PT");
  const seen = new Set(); const out = [];
  for (const [tag, o] of [["foreign", foreign], ["discount", disc], ["multiline", multi], ["PT", pt]]) if (o && !seen.has(o.id)) { seen.add(o.id); out.push({ tag, o }); }
  return out;
}

const mute = (fn) => { const l = console.log, e = console.error; console.log = () => {}; console.error = () => {}; try { return fn(); } finally { console.log = l; console.error = e; } };

async function postDraft(invoice, docType) {
  const res = await fetch(`${IX}/v2/documents?resolvers=on_tax_fallback_search_tax_by_value`, { method: "POST", headers: H, body: JSON.stringify({ data: invoice, type: docType }) });
  const j = await res.json().catch(() => null);
  return { status: res.status, j };
}

const PLAN = {
  "zoolagos.myshopify.com": { numbers: [] },               // auto-pick (force 6%, foreign tests F3)
  "fabrica-coffee-roaster.myshopify.com": { numbers: [] },
  "2d0604-3.myshopify.com": { numbers: [4172, 4228, 4209] }, // multi-rate shipping + drift + clean
  "mwi1cr-7t.myshopify.com": { numbers: [] },                // POS (customer null)
};

await loadTaxes();
console.log(`\n=== DRAFT E2E (IX SANDBOX ${env.IX_ACCOUNT_NAME}, x-env=dev — drafts only, never finalized) ===`);
const results = [];
for (const [dom, plan] of Object.entries(PLAN)) {
  const cfg = loadConfig(dom);
  const builder = new IxBuilder(cfg);
  const docType = cfg.ix_document_type === "invoice_receipt" ? "invoice_receipt" : "invoice";
  const explicit = (cfg.force_tax_rate != null && cfg.force_tax_rate > 0);
  let samples = [];
  if (plan.numbers.length) samples = (await fetchByNumbers(cfg, plan.numbers)).map(o => ({ tag: `#${o.order_number}`, o }));
  else samples = pickSamples(await fetchRecent(cfg));
  console.log(`\n--- ${dom}  (force_tax=${cfg.force_tax_rate ?? "-"} vat_incl=${cfg.vat_included} doctype=${docType}) ---`);
  for (const { tag, o } of samples) {
    const paid = Number(o.total_price);
    let invoice, buildErr = "";
    try { invoice = mute(() => builder.createInvoiceFromNormalizedOrder(toNormalized(o)).invoice); }
    catch (e) { buildErr = String(e?.message ?? e).slice(0, 160); }
    if (!invoice) { console.log(`  [${tag}] #${o.order_number} BUILD-BLOCKED: ${buildErr}`); results.push({ dom, n: o.order_number, ok: false, why: "build-blocked" }); continue; }
    // Mirror createIxInvoiceWithFallback's forced-tax explicit resolution.
    if (explicit) for (const it of invoice.items) if (typeof it.tax === "number" && it.tax === cfg.force_tax_rate) { const ex = explicitForRate(it.tax); if (ex) it.tax = ex; }
    const cc = String(o.billing_address?.country_code ?? "PT").toUpperCase();
    const { status, j } = await postDraft(invoice, docType);
    const inv = j?.data?.invoice ?? j?.data ?? null;
    if (!inv?.id) { console.log(`  [${tag}] #${o.order_number} ${cc} paid=${paid.toFixed(2)} IX-REJECT ${status}: ${JSON.stringify(j).slice(0, 160)}`); results.push({ dom, n: o.order_number, ok: false, why: `ix-reject ${status}` }); continue; }
    const ixTotal = Number(inv.total); const drift = Math.abs(ixTotal - paid);
    const ok = drift <= 0.01;
    console.log(`  [${tag}] #${o.order_number} ${cc} paid=${paid.toFixed(2)} IXtotal=${ixTotal.toFixed(2)} sum=${Number(inv.sum).toFixed(2)} taxes=${Number(inv.taxes).toFixed(2)} drift=${drift.toFixed(2)} ${ok ? "OK" : "DRIFT"} (draft ${inv.id})`);
    results.push({ dom, n: o.order_number, ok, drift, ixId: inv.id });
  }
}
console.log(`\n================ DRAFT E2E SUMMARY ================`);
const bad = results.filter(r => !r.ok);
for (const r of results) console.log(`  ${r.ok ? "OK  " : "FAIL"} ${r.dom} #${r.n}${r.drift != null ? ` drift=${r.drift.toFixed(2)}` : ""}${r.why ? ` (${r.why})` : ""}`);
console.log(`\n${results.length} drafts, ${bad.length} failed.`);
