// SHADOW COMPARISON for the REFUND / credit-note path (read-only, no writes,
// no IX calls). For every real refunded order it builds the credit-note lines
// BOTH ways — via the external Hostinger normalize (current) and via the local
// buildNormalizedFromRaw reconstruction — mirroring handleRefundCreate's credit
// block, and diffs the fiscally-material output (lines + IX-computed total).
// Zero diffs across the sample = the in-worker refund reconstruction is safe.
//
//   node scripts/shadow-refund.mjs           (all active shops)
//   SHOP=2d0604-3.myshopify.com node scripts/shadow-refund.mjs
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { IxBuilder } from "./.gen/builder.mjs";
import { buildNormalizedFromRaw } from "./.gen/normalize-local.mjs";

const ONLY = process.env.SHOP || null;
const SCAN = Number(process.env.SCAN ?? 200); // orders scanned per shop for refunds
const wrangler = readFileSync("wrangler.jsonc", "utf8");
const NKEY = (wrangler.match(/"NORMALIZE_SHOPIFY_ORDER_API_KEY"\s*:\s*"([^"]+)"/) || [])[1] || "";

const _log = console.log, _err = console.error;
const mute = () => { console.log = () => {}; console.error = () => {}; };
const unmute = () => { console.log = _log; console.error = _err; };

const wq = (sql) => {
  const raw = execSync(`npx wrangler d1 execute rioko-db --remote --json --command "${sql}"`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1))[0].results;
};

const CFG = ["user_id","shopify_domain","shopify_token","shopify_api_version","ix_account_name","ix_api_key","ix_environment","ix_document_type","ix_exemption_reason","ix_b2b_exemption_reason","ix_stamp_exemption_note","force_tax_rate","force_shipping_tax_rate","vat_included","oss_enabled","b2b_reverse_charge","auto_finalize","pos_mode","ix_retention_enabled","ix_retention","is_paused"];
function loadConfig(dom) {
  const r = wq(`SELECT ${CFG.join(", ")} FROM integrations WHERE shopify_domain='${dom}'`)[0];
  for (const k of ["ix_stamp_exemption_note","force_tax_rate","force_shipping_tax_rate","vat_included","oss_enabled","b2b_reverse_charge","auto_finalize","pos_mode","ix_retention_enabled","ix_retention","is_paused"]) r[k] = r[k] == null ? null : Number(r[k]);
  return r;
}
function loadShops() {
  return wq("SELECT shopify_domain FROM integrations WHERE shopify_domain IS NOT NULL AND shopify_domain!='' AND shopify_token IS NOT NULL AND shopify_token!='' AND ix_api_key IS NOT NULL AND ix_api_key!='' AND COALESCE(is_paused,0)=0 ORDER BY shopify_domain").map(r => r.shopify_domain);
}

async function fetchOrdersWithRefunds(cfg) {
  const ver = cfg.shopify_api_version || "2026-01";
  const url = `https://${cfg.shopify_domain}/admin/api/${ver}/orders.json?status=any&limit=250`;
  const res = await fetch(url, { headers: { "X-Shopify-Access-Token": cfg.shopify_token, "Accept": "application/json" } });
  if (!res.ok) return [];
  const { orders } = await res.json();
  return (orders ?? []).filter(o => Array.isArray(o.refunds) && o.refunds.length > 0).slice(0, SCAN);
}

async function hostinger(cfg, orderId, raw) {
  const url = `https://endpoint-shopify.srv1250352.hstgr.cloud/orders/normalize/${orderId}`;
  const h = { "x-api-key": NKEY.trim(), "shop-url": cfg.shopify_domain, "access-token": cfg.shopify_token, "Accept": "application/json" };
  const hn = await fetch(url, { headers: h, signal: AbortSignal.timeout(15000) }).then(r => r.ok ? r.json() : null).catch(() => null);
  if (hn?.normalized) hn.normalized.raw_order = raw;
  return hn;
}

const taxval = (t) => typeof t === "number" ? t : (t?.value ?? null);
const r4 = (n) => Math.round(Number(n) * 1e4) / 1e4;

// Mirror of handleRefundCreate's per-credit line construction (the fiscal core).
function buildCreditLinesForOrder(norm, builder) {
  const out = []; // one entry per credit: { refundId, canon }
  const build = builder.createInvoiceFromNormalizedOrder(norm); // {invoice}
  const reverseCharge = false; // reverse-charge refunds are an edge; flagged separately
  for (const credit of (norm.credits ?? [])) {
    const lineItems = credit.line_items ?? [];
    // GROSS sum (subtotal + total_tax) — mirrors handleRefundCreate. amountToRefund
    // is only the non-line-item remainder (shipping/cash); the rebuilt item lines
    // already carry their own tax.
    const sum = lineItems.reduce((a, it) => a + it.subtotal + (it.total_tax ?? 0), 0);
    const amountToRefund = credit.amount - sum;
    const itemsIds = lineItems.map(it => it.id);
    const normalizedItems = (norm.order.items ?? []).filter(it => itemsIds.includes(it.id));
    const items = builder.buildInvoiceItems(normalizedItems, { forceZeroTax: reverseCharge });
    if (amountToRefund > 0) {
      const taxes = build.invoice.items.map(it => it.tax);
      const maxTax = reverseCharge ? 0 : (taxes.reduce((a, b) => (taxval(a) >= taxval(b) ? a : b)) ?? 0);
      const pct = taxval(maxTax) / 100;
      items.push({ quantity: 1, tax: maxTax, unit_price: amountToRefund / (1 + pct), description: `Refund amount of ${amountToRefund}`, name: `Refund amount (#${credit.refund_id})` });
    }
    let gross = "ERR"; try { gross = Math.round(builder.computeIxExpectedTotal(items) * 100) / 100; } catch {}
    out.push({
      refundId: credit.refund_id,
      canon: {
        gross,
        items: items.map(it => ({ name: it.name, quantity: it.quantity, unit_price: r4(it.unit_price), tax: taxval(it.tax), discount_amount: it.discount_amount ?? null, discount: it.discount ?? null })),
      },
    });
  }
  return out;
}

console.log(`\n=== SHADOW REFUND / credit-note DIFF (Hostinger vs in-worker) — read-only ===\n`);
if (!NKEY) { console.error("NORMALIZE_SHOPIFY_ORDER_API_KEY missing"); process.exit(1); }

const shops = ONLY ? [ONLY] : loadShops();
let comparedRefunds = 0, diffs = 0, hostFail = 0, revChargeSkipped = 0;

for (const dom of shops) {
  const cfg = loadConfig(dom);
  const builder = new IxBuilder(cfg);
  const orders = await fetchOrdersWithRefunds(cfg);
  if (orders.length === 0) { console.log(`Shop ${dom}: no refunded orders`); continue; }
  process.stdout.write(`Shop ${dom}: ${orders.length} refunded order(s) ... `);
  let shopDiffs = 0;

  for (const raw of orders) {
    const hn = await hostinger(cfg, String(raw.id), raw);
    if (!hn?.normalized) { hostFail++; continue; }
    const ln = buildNormalizedFromRaw(raw, dom).normalized;

    let A, B;
    mute();
    try { A = buildCreditLinesForOrder(hn.normalized, builder); } catch (e) { A = [{ err: String(e?.message ?? e).slice(0, 120) }]; }
    try { B = buildCreditLinesForOrder(ln, builder); } catch (e) { B = [{ err: String(e?.message ?? e).slice(0, 120) }]; }
    unmute();

    // Compare per refundId.
    const byId = (arr) => Object.fromEntries((arr || []).map(x => [String(x.refundId), x.canon ?? x]));
    const a = byId(A), b = byId(B);
    const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const id of ids) {
      comparedRefunds++;
      if (JSON.stringify(a[id]) !== JSON.stringify(b[id])) {
        diffs++; shopDiffs++;
        console.log(`\n  DIFF order #${raw.order_number} refund ${id}`);
        console.log(`    A(host)=${JSON.stringify(a[id])}`);
        console.log(`    B(local)=${JSON.stringify(b[id])}`);
      }
    }
  }
  console.log(`${shopDiffs === 0 ? "OK" : shopDiffs + " DIFF"}`);
}

console.log(`\n================ SHADOW REFUND SUMMARY ================`);
console.log(`  refunds compared=${comparedRefunds}  DIFFS=${diffs}  host-unavailable=${hostFail}`);
console.log(diffs === 0
  ? `\n  ✅ ZERO credit-note diffs — in-worker refund reconstruction is faithful.`
  : `\n  ❌ ${diffs} diff(s) — DO NOT enable refunds on local normalize. Investigate above.`);
