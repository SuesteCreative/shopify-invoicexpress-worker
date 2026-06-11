// Pre-onboarding HEALTH CHECK (read-only, zero IX footprint).
// For each case-study client: read real config from D1, pull recent paid orders
// from Shopify, run the REAL bundled IxBuilder, and assert the IX gross our code
// would produce matches what the customer actually paid (Shopify total_price)
// within 1 cent. A drift > 1c = an order the live integrator would silently NOT
// invoice (the reconcile guard throws) — exactly the failure that bites onboarding.
//
// Also surfaces: NIF stamping, foreign-client tax, discounts (F1 risk surface),
// multi-line rounding, zero-amount handling. NO writes anywhere. Secrets never
// printed — only order numbers and monetary values.
import { execSync } from "node:child_process";
import { IxBuilder } from "./.gen/builder.mjs";

// Mute the builder's internal console.log/error ([NIF] traces etc.) — we only
// want our own summary. Restore around our own prints.
const _log = console.log, _err = console.error;
const mute = () => { console.log = () => {}; console.error = () => {}; };
const unmute = () => { console.log = _log; console.error = _err; };

const SHOPS = [
  "zoolagos.myshopify.com",
  "fabrica-coffee-roaster.myshopify.com",
  "2d0604-3.myshopify.com",
  "mwi1cr-7t.myshopify.com",
];
const DAYS = Number(process.env.DAYS ?? 60);

const wq = (sql) => {
  const raw = execSync(`npx wrangler d1 execute rioko-db --remote --json --command "${sql}"`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1))[0].results;
};

// Full per-shop config (secrets used in-process, never logged).
function loadConfig(dom) {
  const cols = [
    "user_id", "shopify_domain", "shopify_token", "shopify_api_version",
    "ix_account_name", "ix_api_key", "ix_environment", "ix_document_type",
    "ix_exemption_reason", "ix_b2b_exemption_reason",
    "force_tax_rate", "force_shipping_tax_rate", "vat_included", "oss_enabled",
    "b2b_reverse_charge", "auto_finalize", "pos_mode",
    "ix_retention_enabled", "ix_retention",
  ];
  const r = wq(`SELECT ${cols.join(", ")} FROM integrations WHERE shopify_domain='${dom}'`)[0];
  // numeric coercion (D1 returns numbers already, but be safe)
  for (const k of ["force_tax_rate", "force_shipping_tax_rate", "vat_included", "oss_enabled", "b2b_reverse_charge", "auto_finalize", "pos_mode", "ix_retention_enabled", "ix_retention"]) {
    r[k] = r[k] == null ? null : Number(r[k]);
  }
  return r;
}

async function fetchPaidOrders(cfg) {
  const ver = cfg.shopify_api_version || "2026-01";
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  let url = `https://${cfg.shopify_domain}/admin/api/${ver}/orders.json?status=any&financial_status=paid&processed_at_min=${encodeURIComponent(since)}&limit=250`;
  const out = [];
  let pages = 0;
  while (url && pages < 3) {
    const res = await fetch(url, { headers: { "X-Shopify-Access-Token": cfg.shopify_token, "Accept": "application/json" } });
    if (!res.ok) { console.error(`  ! Shopify ${res.status} for ${cfg.shopify_domain}`); break; }
    const d = await res.json();
    out.push(...(d.orders ?? []));
    pages++;
    url = null;
    const lh = res.headers.get("Link");
    if (lh) { const m = lh.match(/<([^>]+)>;\s*rel="next"/); if (m) url = m[1]; }
  }
  return out;
}

// Build the `normalized` shape the raw path needs from a verbatim Shopify order.
// NOTE: in prod `normalized.order.customer` comes from the external normalize
// service, which returns a customer OBJECT even for guest/POS orders. Shopify's
// raw order has customer=null for those. We default to {} (object) to mirror the
// normalize service — otherwise we'd report false NPEs for POS stores. The fact
// that the builder's pickInvoiceAddress is not null-safe is tracked separately.
function toNormalized(raw) {
  return {
    order: {
      id: raw.id,
      order_number: raw.order_number,
      created_at: raw.created_at,
      customer: raw.customer ?? {},
      billing_address: raw.billing_address ?? {},
      shipping_address: raw.shipping_address ?? {},
      note: raw.note ?? null,
      note_attributes: raw.note_attributes ?? [],
      items: [],
    },
    raw_order: raw,
  };
}

const r2 = (n) => Math.round(n * 100) / 100;

async function checkShop(dom) {
  const cfg = loadConfig(dom);
  const builder = new IxBuilder(cfg);
  const orders = await fetchPaidOrders(cfg);

  const rows = [];
  let drift = 0, foreign = 0, withNif = 0, discounted = 0, multiline = 0, zero = 0, threw = 0;

  for (const o of orders) {
    const total = Number(o.total_price);
    const cc = String(o.billing_address?.country_code ?? "").toUpperCase();
    const isForeign = cc && cc !== "PT";
    const hasDisc = Number(o.total_discounts ?? 0) > 0 ||
      (o.line_items ?? []).some(li => (li.discount_allocations ?? []).length > 0);
    const nLines = (o.line_items ?? []).filter(li => Number(li.price) > 0).length;

    if (!Number.isFinite(total) || total <= 0) { zero++; continue; }
    if (isForeign) foreign++;
    if (hasDisc) discounted++;
    if (nLines > 1) multiline++;

    let expected = null, guardThrew = false, errMsg = "", fiscal = null, country = "";
    mute();
    try {
      const items = builder.buildInvoiceItemsFromRaw(o);
      expected = builder.computeIxExpectedTotal(items);
      const client = builder.buildInvoiceClient(toNormalized(o));
      fiscal = client.fiscal_id ?? null;
      country = client.country ?? "";
    } catch (e) { errMsg = String(e?.message ?? e).slice(0, 140); }
    // Run the actual guarded path to see if the live code would abort.
    try { builder.createInvoiceFromNormalizedOrder(toNormalized(o)); }
    catch (e) { guardThrew = true; if (!errMsg) errMsg = String(e?.message ?? e).slice(0, 200); }
    unmute();

    if (fiscal) withNif++;
    const d = expected == null ? Infinity : Math.abs(expected - total);
    const bad = guardThrew || d > 0.01;
    if (bad) { drift++; }
    if (guardThrew) threw++;

    if (bad) rows.push({ n: o.order_number, total: total.toFixed(2), exp: expected == null ? "ERR" : expected.toFixed(2), d: Number.isFinite(d) ? d.toFixed(2) : "ERR", cc: cc || "PT", disc: hasDisc ? "D" : "", nLines, err: errMsg });
  }

  return { dom, cfg, n: orders.length, zero, foreign, withNif, discounted, multiline, drift, threw, rows };
}

console.log(`\n=== Shopify→IX HEALTH CHECK (last ${DAYS}d paid, real builder, NO writes) ===\n`);
const summary = [];
for (const dom of SHOPS) {
  process.stdout.write(`Checking ${dom} ... `);
  try {
    const r = await checkShop(dom);
    summary.push(r);
    console.log(`${r.n} orders`);
    console.log(`  profile: vat_included=${r.cfg.vat_included} force_tax=${r.cfg.force_tax_rate ?? "-"} force_ship=${r.cfg.force_shipping_tax_rate ?? "-"} pos=${r.cfg.pos_mode} doctype=${r.cfg.ix_document_type} env=${r.cfg.ix_environment}`);
    console.log(`  scanned: paid=${r.n} zero=${r.zero} foreign=${r.foreign} discounted=${r.discounted} multiline=${r.multiline} nif_stamped=${r.withNif}`);
    console.log(`  >>> DRIFT/BLOCKED orders (would NOT invoice cleanly): ${r.drift}  (guard-threw=${r.threw})`);
    for (const x of r.rows.slice(0, 25)) {
      console.log(`      #${x.n}  paid=${x.total}  ixExpected=${x.exp}  drift=${x.d}  ${x.cc}${x.disc ? " "+x.disc : ""}${x.nLines>1?` lines=${x.nLines}`:""}${x.err ? `  | ${x.err}` : ""}`);
    }
    if (r.rows.length > 25) console.log(`      ... +${r.rows.length - 25} more`);
  } catch (e) {
    console.log(`ERROR: ${String(e?.message ?? e).slice(0, 200)}`);
  }
  console.log("");
}

console.log("================ SUMMARY ================");
for (const r of summary) {
  const verdict = r.drift === 0 ? "OK" : `${r.drift} DRIFT`;
  console.log(`  ${verdict.padEnd(10)} ${r.dom}  (paid=${r.n}, foreign=${r.foreign}, discounted=${r.discounted})`);
}
const totalDrift = summary.reduce((a, r) => a + r.drift, 0);
console.log(`\nTotal drift/blocked orders across all clients: ${totalDrift}`);
