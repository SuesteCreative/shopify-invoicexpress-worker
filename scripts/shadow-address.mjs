// SHADOW ADDRESS DIFF — the old address merge vs the new one (read-only).
//
// `IxBuilder.pickInvoiceAddress` merged four address layers with a plain spread,
// which overwrites on key PRESENCE rather than on usefulness. Every Stripe shape
// sets `customer.address` to an all-empty address and that layer is spread LAST,
// so a street the payment carried was erased by one that said nothing. The zip
// had a hand-written workaround for the same reason and the city escaped by
// never going through the merge; the street had neither.
//
// The fix drops blank fields before each spread (`presentFields`). Precedence is
// unchanged — a filled value still loses to a later filled value. The only thing
// that stops happening is losing to nothing.
//
// This script proves that on real orders, for the population that could REGRESS:
// the Shopify→IX fleet, where `customer.address` holds a real saved address and
// winning is the precedence those shops have always had. Stripe-sourced accounts
// are not the risk — their merged street is blank today, so it can only improve;
// Bestisafil is verified live after deploy by re-emitting a document.
//
// Every difference is classified, and only one class is allowed:
//   filled → different   BLOCKER. Precedence moved. Never acceptable.
//   filled → empty       BLOCKER. Data lost.
//   empty  → filled      the point of the change. Reported per field, per shop,
//                        and must be READ before shipping — Shopify sends "" for
//                        a missing address2 constantly, so movement is expected.
//
// NO writes. NO InvoiceXpress calls (the builder runs in-process).
//
//   DAYS=60 MAX=40 node scripts/shadow-address.mjs
//   SHOP=2d0604-3.myshopify.com node scripts/shadow-address.mjs
import { execSync } from "node:child_process";
import { IxBuilder } from "./.gen/builder.mjs";
import { buildNormalizedFromRaw } from "./.gen/normalize-local.mjs";

const DAYS = Number(process.env.DAYS ?? 60);
const MAX = Number(process.env.MAX ?? 40);
const ONLY = process.env.SHOP || null;
const SINCE_ISO = new Date(Date.now() - DAYS * 864e5).toISOString();

const _log = console.log, _err = console.error;
const mute = () => { console.log = () => {}; console.error = () => {}; };
const unmute = () => { console.log = _log; console.error = _err; };

const wq = (sql) => {
  const raw = execSync(`npx wrangler d1 execute rioko-db --remote --json --command "${sql}"`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1))[0].results;
};

const CFG_COLS = [
  "user_id", "shopify_domain", "shopify_token", "shopify_api_version",
  "ix_document_type", "ix_exemption_reason", "ix_b2b_exemption_reason",
  "force_tax_rate", "force_shipping_tax_rate", "vat_included", "oss_enabled",
  "b2b_reverse_charge", "auto_finalize", "pos_mode", "is_paused",
];
function loadConfig(dom) {
  const r = wq(`SELECT ${CFG_COLS.join(", ")} FROM integrations WHERE shopify_domain='${dom}'`)[0];
  for (const k of ["force_tax_rate", "force_shipping_tax_rate", "vat_included", "oss_enabled", "b2b_reverse_charge", "auto_finalize", "pos_mode", "is_paused"]) {
    r[k] = r[k] == null ? null : Number(r[k]);
  }
  return r;
}

function loadShops() {
  return wq(
    "SELECT shopify_domain FROM integrations WHERE shopify_domain IS NOT NULL AND shopify_domain != '' " +
    "AND shopify_token IS NOT NULL AND shopify_token != '' AND ix_api_key IS NOT NULL AND ix_api_key != '' " +
    "AND COALESCE(is_paused,0)=0 ORDER BY shopify_domain",
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

/** The merge exactly as it was before the fix. Restored onto the prototype so
 *  the OLD side runs through the SAME real builder as the NEW side — everything
 *  downstream of the merge (name capping, NIF extraction, country naming) is
 *  then provably identical, and any diff is the merge's alone. */
const oldPickInvoiceAddress = function (normalized) {
  const customer = normalized.order.customer ?? {};
  return {
    ...normalized.order.shipping_address ?? {},
    ...customer.default_address ?? {},
    ...normalized.order.billing_address ?? {},
    ...customer.address ?? {},
  };
};
const newPickInvoiceAddress = IxBuilder.prototype.pickInvoiceAddress;

/** The client fields a merge can reach. `fiscal_id` is in the list precisely
 *  because it must NEVER move: it is read from billing/shipping address2
 *  directly, and a diff here would mean the fix touched fiscal identity. */
const FIELDS = ["address", "postal_code", "city", "country", "name", "fiscal_id", "email", "phone"];

const blank = (v) => v == null || String(v).trim() === "";

function buildClientWith(pick, builder, normalized) {
  IxBuilder.prototype.pickInvoiceAddress = pick;
  mute();
  try { return builder.buildInvoiceClient(normalized); }
  catch (e) { return { __err: String(e?.message ?? e).slice(0, 120) }; }
  finally { unmute(); IxBuilder.prototype.pickInvoiceAddress = newPickInvoiceAddress; }
}

console.log(`\n=== SHADOW ADDRESS DIFF (old merge vs new) — last ${DAYS}d paid, max ${MAX}/shop, NO writes ===\n`);

const shops = ONLY ? [ONLY] : loadShops();
let compared = 0;
const blockers = [];
const gains = {};   // field -> count of empty→filled
const perShop = {};

for (const dom of shops) {
  const cfg = loadConfig(dom);
  const builder = new IxBuilder(cfg);
  const orders = (await fetchPaidOrders(cfg)).filter((o) => Number(o.total_price) > 0).slice(0, MAX);
  process.stdout.write(`Shop ${dom}: ${orders.length} sampled ... `);
  let shopGains = 0, shopBlockers = 0;

  for (const o of orders) {
    let normalized;
    try { normalized = buildNormalizedFromRaw(o, dom).normalized; }
    catch { continue; }

    const before = buildClientWith(oldPickInvoiceAddress, builder, normalized);
    const after = buildClientWith(newPickInvoiceAddress, builder, normalized);
    compared++;

    if (before.__err || after.__err) {
      if (String(before.__err) !== String(after.__err)) {
        shopBlockers++;
        blockers.push({ dom, order: o.order_number, field: "<throw>", before: before.__err ?? null, after: after.__err ?? null });
      }
      continue;
    }

    for (const f of FIELDS) {
      const a = before[f], b = after[f];
      if (String(a ?? "") === String(b ?? "")) continue;
      if (blank(a) && !blank(b)) {
        gains[f] = (gains[f] ?? 0) + 1; shopGains++;
        perShop[dom] = perShop[dom] ?? {};
        perShop[dom][f] = (perShop[dom][f] ?? 0) + 1;
      } else {
        shopBlockers++;
        blockers.push({ dom, order: o.order_number, field: f, before: a ?? null, after: b ?? null });
      }
    }
  }
  console.log(`${shopBlockers ? `${shopBlockers} BLOCKER` : "ok"}  (+${shopGains} filled)`);
}

console.log(`\n================ SHADOW ADDRESS SUMMARY ================`);
console.log(`  orders compared: ${compared}`);
console.log(`  empty → filled, by field: ${Object.keys(gains).length ? Object.entries(gains).map(([k, v]) => `${k}=${v}`).join(" ") : "(none)"}`);
for (const [dom, fields] of Object.entries(perShop)) {
  console.log(`    ${dom}: ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ")}`);
}

if (blockers.length) {
  console.log(`\n  ❌ ${blockers.length} BLOCKER(S) — a filled value changed or was lost. DO NOT SHIP.`);
  for (const b of blockers.slice(0, 40)) {
    console.log(`    ${b.dom} #${b.order} ${b.field}: ${JSON.stringify(b.before)} → ${JSON.stringify(b.after)}`);
  }
  process.exitCode = 1;
} else {
  console.log(`\n  ✅ No filled value changed or was lost across ${compared} real orders.`);
  console.log(`     Read the empty → filled counts above before shipping: they are the`);
  console.log(`     intended effect, and every one of them is a field that will now`);
  console.log(`     appear on a document where it did not before.`);
  if (!gains.address) {
    console.log(`     NOTE: no street was gained on the Shopify fleet — expected, since the`);
    console.log(`     trap is the all-empty customer address only Stripe shapes produce.`);
  }
  if (gains.fiscal_id) {
    console.log(`\n  ❌ fiscal_id MOVED. That field is read from billing/shipping address2`);
    console.log(`     directly and must be untouched by a merge change. DO NOT SHIP.`);
    process.exitCode = 1;
  }
}
