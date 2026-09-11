// TAX PARAMETER AUDIT (read-only, zero writes, zero destination API calls).
//
// audit-shopify.mjs answers "does the total match what was paid". This answers
// the other half, the one a matching total hides: is the document under the
// RIGHT REGIME. A shipping line stamped 23% inside an art. 53 exemption totals
// perfectly and is still wrong, so no drift check will ever see it.
//
// Per Shopify->IX shop it replays recent paid orders through the real bundled
// IxBuilder with the shop's real config, then reports the distinct rates that
// actually landed on product and shipping lines, and contradictions against the
// declared regime.
//
//   DAYS=60 node scripts/audit-tax-params.mjs
//   SHOP=acme.myshopify.com node scripts/audit-tax-params.mjs
import { execSync } from "node:child_process";
import { IxBuilder } from "./.gen/builder.mjs";

const ONLY = process.env.SHOP || null;
const DAYS = Number(process.env.DAYS ?? 60);
const SINCE_ISO = new Date(Date.now() - DAYS * 864e5).toISOString();

const _log = console.log, _err = console.error;
const mute = () => { console.log = () => {}; console.error = () => {}; };
const unmute = () => { console.log = _log; console.error = _err; };

const wq = (sql) => {
  const raw = execSync(`npx wrangler d1 execute rioko-db --remote --json --command "${sql}"`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1))[0].results;
};

// Art. 53 and the small-scheme articles say the merchant charges no VAT at all.
// A positive rate under one of these is a contradiction, not a preference.
const ZERO_ONLY_CODES = new Set(["M10", "M07", "M11", "M12", "M13"]);

const NUMERIC_COLS = [
  "force_tax_rate", "force_shipping_tax_rate", "vat_included", "oss_enabled",
  "b2b_reverse_charge", "auto_finalize", "pos_mode", "is_paused",
  "ix_stamp_exemption_note", "ix_derive_exemption",
];

function loadConfig(dom) {
  const cols = [
    "user_id", "shopify_domain", "shopify_token", "shopify_api_version",
    "ix_account_name", "ix_api_key", "ix_environment", "ix_document_type",
    "ix_exemption_reason", "ix_b2b_exemption_reason", ...NUMERIC_COLS,
  ];
  const r = wq(`SELECT ${cols.join(", ")} FROM integrations WHERE shopify_domain='${dom}'`)[0];
  for (const k of NUMERIC_COLS) r[k] = r[k] == null ? null : Number(r[k]);
  return r;
}

// The pipeline hands these to the builder as its third argument, and without
// them every per-SKU rate and the whole RIOKO-ISBN-BOOK rule silently fall
// through to force_tax_rate — a bookseller's 6% catalogue reads back as 23%.
function loadOverrides(userId) {
  return wq(`SELECT source_reference, tax_rate, vat_inclusion, exemption_reason, name_override FROM product_overrides WHERE user_id='${userId}' AND destination_kind='invoicexpress'`);
}

async function fetchPaidOrders(cfg) {
  const ver = cfg.shopify_api_version || "2026-01";
  let url = `https://${cfg.shopify_domain}/admin/api/${ver}/orders.json?status=any&financial_status=paid&processed_at_min=${encodeURIComponent(SINCE_ISO)}&limit=250`;
  const out = [];
  for (let page = 0; page < 4 && url; page++) {
    const res = await fetch(url, { headers: { "X-Shopify-Access-Token": cfg.shopify_token } });
    if (!res.ok) return { orders: out, httpErr: String(res.status) };
    const body = await res.json();
    out.push(...(body.orders ?? []));
    const m = (res.headers.get("link") ?? "").match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
  }
  return { orders: out, httpErr: null };
}

const key = (n) => (Math.round(n * 100) / 100).toFixed(2).replace(/\.00$/, "") + "%";

async function checkShop(shop) {
  const cfg = loadConfig(shop.shopify_domain);
  const overrides = loadOverrides(cfg.user_id);
  const builder = new IxBuilder(cfg, undefined, new Map(overrides.map((o) => [o.source_reference, o])));

  const { orders, httpErr } = await fetchPaidOrders(cfg);
  const prodRates = new Map(), shipRates = new Map();
  let n = 0, threw = 0, shippingOrders = 0;

  for (const o of orders) {
    if (!(Number(o.total_price) > 0)) continue;
    n++;
    mute();
    let items = null;
    try { items = builder.buildInvoiceItemsFromRaw(o); } catch { threw++; }
    unmute();
    if (!items) continue;
    if ((o.shipping_lines ?? []).some((sl) => Number(sl?.price ?? 0) > 0)) shippingOrders++;
    for (const it of items) {
      const bucket = /^Portes de envio/.test(String(it.name ?? "")) ? shipRates : prodRates;
      const raw = Number(it.tax?.value ?? it.tax ?? 0);
      const k = key(Number.isFinite(raw) ? raw : 0);
      bucket.set(k, (bucket.get(k) ?? 0) + 1);
    }
  }
  return { dom: shop.shopify_domain, cfg, overrides, httpErr, n, threw, shippingOrders, prodRates, shipRates };
}

function findings(r) {
  const out = [];
  const { cfg } = r;
  const nonZero = (m) => [...m.keys()].filter((k) => parseFloat(k) > 0);
  const nonZeroProd = nonZero(r.prodRates), nonZeroShip = nonZero(r.shipRates);

  if (ZERO_ONLY_CODES.has(String(cfg.ix_exemption_reason))) {
    if (nonZeroProd.length) out.push(`REGIME: ${cfg.ix_exemption_reason} nao liquida IVA, mas artigos saem a ${nonZeroProd.join(", ")}`);
    if (nonZeroShip.length) out.push(`REGIME: ${cfg.ix_exemption_reason} nao liquida IVA, mas portes saem a ${nonZeroShip.join(", ")}`);
  }
  if (cfg.force_tax_rate != null && cfg.force_shipping_tax_rate == null && r.shippingOrders > 0) {
    out.push(`PORTES LIVRES: artigos impostos a ${cfg.force_tax_rate}%, portes sem regra (observado: ${[...r.shipRates.keys()].join(", ") || "-"})`);
  }
  if (cfg.force_tax_rate == null && cfg.force_shipping_tax_rate != null) {
    out.push(`ARTIGOS LIVRES: portes impostos a ${cfg.force_shipping_tax_rate}%, artigos sem regra (observado: ${[...r.prodRates.keys()].join(", ") || "-"})`);
  }
  // On the Shopify path the line math reads the ORDER's `taxes_included`, never
  // this column. Its only effect here is as the third precondition of
  // resolveReverseCharge (builder.ts), where a 0 skips reverse charge outright
  // and leaves no trace on the document.
  if (cfg.b2b_reverse_charge === 1 && cfg.vat_included !== 1) {
    out.push("AUTOLIQUIDACAO MORTA: b2b_reverse_charge=1 mas vat_included!=1, resolveReverseCharge devolve skip sempre");
  }
  if (cfg.b2b_reverse_charge === 1 && cfg.oss_enabled !== 1) {
    out.push("AUTOLIQUIDACAO MORTA: b2b_reverse_charge=1 mas oss_enabled!=1, resolveReverseCharge devolve skip sempre");
  }
  // Shipping follows the supply it carries. Portes at 23% on a document whose
  // every article is exempt or reduced is the shape of both the art. 14 book
  // seller and the 6% ticket office, and it totals perfectly either way.
  const maxProd = Math.max(0, ...[...r.prodRates.keys()].map(parseFloat));
  const overShip = [...r.shipRates.keys()].filter((k) => parseFloat(k) > maxProd);
  if (overShip.length && r.prodRates.size) {
    out.push(`PORTES ACIMA DOS ARTIGOS: artigos no maximo ${key(maxProd)}, portes a ${overShip.join(", ")}`);
  }
  if (String(cfg.ix_exemption_reason) === "M40") {
    out.push("ISENCAO GLOBAL M40 (autoliquidacao art. 6 n6) em QUALQUER linha a 0%: exportacao fora da UE devia ser M05");
  }
  return out;
}

const shops = wq(
  "SELECT user_id, shopify_domain, is_paused FROM integrations " +
  "WHERE shopify_domain IS NOT NULL AND shopify_token IS NOT NULL AND ix_api_key IS NOT NULL " +
  (ONLY ? `AND shopify_domain = '${ONLY.replace(/'/g, "''")}' ` : "") + "ORDER BY shopify_domain"
);

console.log(`\nAUDITORIA DE PARAMETROS FISCAIS - ${shops.length} lojas Shopify->IX, ultimos ${DAYS} dias\n`);
const flagged = [];
for (const s of shops) {
  const r = await checkShop(s);
  const c = r.cfg;
  console.log(`-- ${r.dom}`);
  console.log(`   isencao=${c.ix_exemption_reason ?? "-"}  b2b=${c.ix_b2b_exemption_reason ?? "-"}  ftr=${c.force_tax_rate ?? "livre"}  fstr=${c.force_shipping_tax_rate ?? "livre"}  vat_incl=${c.vat_included}  oss=${c.oss_enabled}  rc=${c.b2b_reverse_charge}  finaliza=${c.auto_finalize}${c.is_paused ? "  PAUSADA" : ""}`);
  if (r.overrides.length) console.log(`   overrides: ${r.overrides.map((o) => `${o.source_reference}=${o.tax_rate ?? "-"}%`).join(", ")}`);
  if (r.httpErr) { console.log(`   ! Shopify ${r.httpErr} - sem amostra\n`); continue; }
  const fmt = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}x${v}`).join("  ") || "-";
  console.log(`   ${r.n} encomendas | artigos: ${fmt(r.prodRates)} | portes: ${fmt(r.shipRates)}${r.threw ? ` | ${r.threw} recusadas pela guarda` : ""}`);
  const f = findings(r);
  if (f.length) flagged.push(r.dom);
  for (const line of f) console.log(`   ! ${line}`);
  console.log("");
}
console.log(`RESUMO: ${flagged.length} de ${shops.length} lojas com parametros a rever: ${flagged.join(", ") || "nenhuma"}\n`);
