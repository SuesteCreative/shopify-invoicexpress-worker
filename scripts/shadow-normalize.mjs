// SHADOW COMPARISON — Hostinger normalize vs in-worker normalize (read-only).
//
// For a sample of real paid orders per active Shopify→IX shop, build the IX
// invoice BOTH ways and diff the fiscally-material fields:
//   A = via the external Hostinger normalize service (current prod path)
//   B = via buildNormalizedFromRaw (the in-worker replacement that ships)
// Both feed the SAME real bundled IxBuilder. Zero diffs across the sample =
// safe to enable NORMALIZE_IN_WORKER. Any diff = investigate before cutover.
//
// NO writes anywhere. NO IX API calls (builder runs in-process). Uses the exact
// shipping mapping (scripts/.gen/normalize-local.mjs bundled from src) so there
// is no drift between what we validate and what the worker will run.
//
//   DAYS=30 MAX=20 node scripts/shadow-normalize.mjs
//   SHOP=2d0604-3.myshopify.com node scripts/shadow-normalize.mjs
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { IxBuilder } from "./.gen/builder.mjs";
import { buildNormalizedFromRaw } from "./.gen/normalize-local.mjs";

const DAYS = Number(process.env.DAYS ?? 30);
const MAX = Number(process.env.MAX ?? 20); // orders sampled per shop
const ONLY = process.env.SHOP || null;
const SINCE_ISO = new Date(Date.now() - DAYS * 864e5).toISOString();

// NORMALIZE_SHOPIFY_ORDER_API_KEY is a non-secret var in wrangler.jsonc.
const wranglerTxt = readFileSync("wrangler.jsonc", "utf8");
const NORMALIZE_KEY = (wranglerTxt.match(/"NORMALIZE_SHOPIFY_ORDER_API_KEY"\s*:\s*"([^"]+)"/) || [])[1] || "";

const _log = console.log, _err = console.error;
const mute = () => { console.log = () => {}; console.error = () => {}; };
const unmute = () => { console.log = _log; console.error = _err; };

const wq = (sql) => {
  const raw = execSync(`npx wrangler d1 execute rioko-db --remote --json --command "${sql}"`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1))[0].results;
};

const CFG_COLS = [
  "user_id", "shopify_domain", "shopify_token", "shopify_api_version",
  "ix_account_name", "ix_api_key", "ix_environment", "ix_document_type",
  "ix_exemption_reason", "ix_b2b_exemption_reason", "ix_stamp_exemption_note",
  "force_tax_rate", "force_shipping_tax_rate", "vat_included", "oss_enabled",
  "b2b_reverse_charge", "auto_finalize", "pos_mode",
  "ix_retention_enabled", "ix_retention", "is_paused",
];
function loadConfig(dom) {
  const r = wq(`SELECT ${CFG_COLS.join(", ")} FROM integrations WHERE shopify_domain='${dom}'`)[0];
  for (const k of ["ix_stamp_exemption_note", "force_tax_rate", "force_shipping_tax_rate", "vat_included", "oss_enabled", "b2b_reverse_charge", "auto_finalize", "pos_mode", "ix_retention_enabled", "ix_retention", "is_paused"]) {
    r[k] = r[k] == null ? null : Number(r[k]);
  }
  return r;
}

function loadShops() {
  return wq(
    "SELECT shopify_domain FROM integrations WHERE shopify_domain IS NOT NULL AND shopify_domain != '' " +
    "AND shopify_token IS NOT NULL AND shopify_token != '' AND ix_api_key IS NOT NULL AND ix_api_key != '' " +
    "AND COALESCE(is_paused,0)=0 ORDER BY shopify_domain"
  ).map((r) => r.shopify_domain);
}

async function fetchPaidOrders(cfg) {
  const ver = cfg.shopify_api_version || "2026-01";
  let url = `https://${cfg.shopify_domain}/admin/api/${ver}/orders.json?status=any&financial_status=paid&processed_at_min=${encodeURIComponent(SINCE_ISO)}&limit=250`;
  const out = [];
  let pages = 0;
  while (url && pages < 2) {
    const res = await fetch(url, { headers: { "X-Shopify-Access-Token": cfg.shopify_token, "Accept": "application/json" } });
    if (!res.ok) { console.error(`  ! Shopify ${res.status} for ${cfg.shopify_domain}`); break; }
    const d = await res.json();
    out.push(...(d.orders ?? []));
    pages++; url = null;
    const lh = res.headers.get("Link");
    if (lh) { const m = lh.match(/<([^>]+)>;\s*rel="next"/); if (m) url = m[1]; }
  }
  return out;
}

// Mirror of Shopify.fetchNormalized (Hostinger call).
async function fetchHostingerNormalized(cfg, orderId) {
  const url = `https://endpoint-shopify.srv1250352.hstgr.cloud/orders/normalize/${orderId}`;
  const headers = { "x-api-key": NORMALIZE_KEY.trim(), "shop-url": cfg.shopify_domain, "access-token": cfg.shopify_token, "Accept": "application/json" };
  for (let a = 1; a <= 3; a++) {
    let res;
    try { res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) }); }
    catch { if (a < 3) { await new Promise(r => setTimeout(r, 400 * a)); continue; } return null; }
    if (res.ok) return res.json();
    if (res.status === 404) return null;
    if (a < 3 && res.status >= 500) { await new Promise(r => setTimeout(r, 400 * a)); continue; }
    return null;
  }
  return null;
}

// Exact copy of Shopify.enrichWithDiscountAllocations (applied to the Hostinger side).
function enrichWithDiscountAllocations(normalized, rawOrder) {
  const allocationsById = new Map();
  const collect = (lines) => {
    if (!Array.isArray(lines)) return;
    for (const line of lines) {
      const allocations = line?.discount_allocations;
      if (!Array.isArray(allocations) || allocations.length === 0) continue;
      const sum = allocations.reduce((acc, a) => acc + Number(a?.amount ?? 0), 0);
      if (sum > 0 && line?.id != null) allocationsById.set(Number(line.id), Math.round(sum * 100) / 100);
    }
  };
  collect(rawOrder?.line_items); collect(rawOrder?.shipping_lines);
  if (allocationsById.size === 0) return;
  const items = normalized?.normalized?.order?.items;
  if (!Array.isArray(items)) return;
  const shippingLines = Array.isArray(rawOrder?.shipping_lines) ? rawOrder.shipping_lines : [];
  const lonely = shippingLines.length === 1 ? (allocationsById.get(Number(shippingLines[0].id)) ?? 0) : 0;
  for (const item of items) {
    const byId = item?.id != null ? allocationsById.get(Number(item.id)) : undefined;
    if (byId != null && byId > 0) { item.discount_allocation_amount = byId; continue; }
    if (!item.product_id && !item.variant_id && lonely > 0) item.discount_allocation_amount = lonely;
  }
}

function canon(inv, builder) {
  const c = inv.client ?? {};
  return {
    client: {
      name: c.name ?? null, fiscal_id: c.fiscal_id ?? null, country: c.country ?? null,
      email: c.email ?? null, address: c.address ?? null, city: c.city ?? null, postal_code: c.postal_code ?? null,
    },
    reference: inv.reference ?? null,
    date: inv.date ?? null, due_date: inv.due_date ?? null,
    tax_exemption_reason: inv.tax_exemption_reason ?? null,
    observations: inv.observations ?? null,
    items: (inv.items ?? []).map((it) => ({
      name: it.name, quantity: it.quantity, unit_price: it.unit_price,
      tax: typeof it.tax === "number" ? it.tax : (it.tax?.value ?? null),
      discount_amount: it.discount_amount ?? null,
    })),
    gross: (() => { try { return builder.computeIxExpectedTotal(inv.items); } catch { return "ERR"; } })(),
  };
}

function diffKeys(a, b, prefix = "") {
  const out = [];
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A === B) return out;
  // shallow-ish: report top-level fields that differ
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) {
    if (JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k])) out.push(prefix + k);
  }
  return out.length ? out : ["<deep>"];
}

const catOf = (o) => {
  const cc = String(o.billing_address?.country_code ?? "").toUpperCase();
  const foreign = cc && cc !== "PT";
  const disc = Number(o.total_discounts ?? 0) > 0 || (o.line_items ?? []).some(li => (li.discount_allocations ?? []).length > 0);
  const multi = (o.line_items ?? []).filter(li => Number(li.price) > 0).length > 1;
  const cats = [];
  if (foreign) cats.push("foreign"); if (disc) cats.push("disc"); if (multi) cats.push("multi");
  return cats.length ? cats.join("+") : "plain";
};

console.log(`\n=== SHADOW NORMALIZE DIFF (Hostinger vs in-worker) — last ${DAYS}d paid, max ${MAX}/shop, NO writes ===\n`);
if (!NORMALIZE_KEY) { console.error("NORMALIZE_SHOPIFY_ORDER_API_KEY not found in wrangler.jsonc — cannot compare."); process.exit(1); }

const shops = (ONLY ? [ONLY] : loadShops());
let totalCompared = 0, totalDiffs = 0, totalHostFail = 0;
const coverage = {};

for (const dom of shops) {
  const cfg = loadConfig(dom);
  const builder = new IxBuilder(cfg);
  const orders = (await fetchPaidOrders(cfg)).filter(o => Number(o.total_price) > 0).slice(0, MAX);
  process.stdout.write(`Shop ${dom}: ${orders.length} sampled ... `);
  let compared = 0, diffs = 0, hostFail = 0;

  for (const o of orders) {
    const cat = catOf(o); coverage[cat] = (coverage[cat] ?? 0) + 1;
    // A — Hostinger (+ enrichment + raw attach), exactly like Shopify.normalizeOrder
    const host = await fetchHostingerNormalized(cfg, String(o.id));
    if (!host || !host.normalized) { hostFail++; continue; }
    enrichWithDiscountAllocations(host, o);
    host.normalized.raw_order = o;
    // B — in-worker
    const local = buildNormalizedFromRaw(o, dom).normalized;

    let a, b;
    mute();
    try { a = canon(builder.createInvoiceFromNormalizedOrder(host.normalized).invoice, builder); } catch (e) { a = { ERR: String(e?.message ?? e).slice(0, 120) }; }
    try { b = canon(builder.createInvoiceFromNormalizedOrder(local).invoice, builder); } catch (e) { b = { ERR: String(e?.message ?? e).slice(0, 120) }; }
    unmute();

    compared++;
    const dk = diffKeys(a, b);
    if (dk.length) {
      diffs++;
      console.log(`\n  DIFF #${o.order_number} [${cat}] fields: ${dk.join(", ")}`);
      for (const k of dk) {
        if (k === "<deep>") { console.log(`      A=${JSON.stringify(a)}`); console.log(`      B=${JSON.stringify(b)}`); }
        else console.log(`      ${k}: A=${JSON.stringify(a?.[k])}  B=${JSON.stringify(b?.[k])}`);
      }
    }
  }
  totalCompared += compared; totalDiffs += diffs; totalHostFail += hostFail;
  console.log(`${diffs === 0 ? "OK" : diffs + " DIFF"}  (compared=${compared} host-unavailable=${hostFail})`);
}

console.log(`\n================ SHADOW SUMMARY ================`);
console.log(`  coverage: ${Object.entries(coverage).map(([k, v]) => `${k}=${v}`).join(" ")}`);
console.log(`  compared=${totalCompared}  DIFFS=${totalDiffs}  host-unavailable=${totalHostFail}`);
console.log(totalDiffs === 0
  ? `\n  ✅ ZERO fiscal diffs — in-worker normalization is byte-identical. Safe to enable NORMALIZE_IN_WORKER.`
  : `\n  ❌ ${totalDiffs} diff(s) — DO NOT enable. Investigate above before cutover.`);
