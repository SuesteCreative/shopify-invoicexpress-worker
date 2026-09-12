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

// EU-27, to tell an export apart from an intra-Community supply. The two take
// different articles and the shop states only one code for both.
const EU = new Set(["AT","BE","BG","CY","CZ","DE","DK","EE","ES","FI","FR","GR","HR","HU","IE","IT","LT","LU","LV","MT","NL","PL","PT","RO","SE","SI","SK"]);

// What each code actually names, so a mismatch can be stated rather than hinted.
const CODE_MEANS = {
  M05: { name: "Isento artigo 14.º do CIVA", covers: "fora-UE", gloss: "exportação e assimiladas" },
  M16: { name: "Isento artigo 14.º do RITI", covers: "UE", gloss: "transmissão intracomunitária de bens" },
  M40: { name: "Autoliquidação artigo 6.º n.º 6", covers: "UE", gloss: "serviços a sujeito passivo de outro Estado-membro" },
};

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

// Which rule decided this line, in the builder's own precedence order. A rate
// alone does not say whether 23% is the merch rate working correctly or a book
// that fell past every override, and those are opposite problems.
const isIsbn13 = (s) => /^97[89]\d{10}$/.test(String(s ?? "").replace(/[-\s]/g, ""));

function whyRate(li, ovr, cfg) {
  const sku = String(li?.sku ?? "").trim();
  // SKU outranks variant id: a line WITH a SKU never reads a RIOKO-VARIANT-*
  // row, so a book whose SKU is not a valid ISBN-13 misses both and lands on
  // force_tax_rate. That is the silent one.
  const k = sku ? sku.slice(0, 30) : li?.variant_id ? `RIOKO-VARIANT-${li.variant_id}`.slice(0, 30) : li?.product_id ? `RIOKO-PRODUCT-${li.product_id}`.slice(0, 30) : "RIOKO-SHIPPING";
  if (ovr.get(k)?.tax_rate != null) return `override ${k}`;
  if (ovr.get("RIOKO-ISBN-BOOK")?.tax_rate != null && isIsbn13(sku)) return "regra ISBN";
  if (cfg.force_tax_rate != null) return `force_tax_rate ${cfg.force_tax_rate}%`;
  return "taxa da Shopify";
}

async function checkShop(shop) {
  const cfg = loadConfig(shop.shopify_domain);
  const overrides = loadOverrides(cfg.user_id);
  const ovr = new Map(overrides.map((o) => [o.source_reference, o]));
  const builder = new IxBuilder(cfg, undefined, ovr);

  const { orders, httpErr } = await fetchPaidOrders(cfg);
  const prodRates = new Map(), shipRates = new Map(), detail = new Map(), nearMiss = new Map(), zeroDest = new Map();
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
    // Where a zero-rated line actually went. The shop states ONE exemption code
    // and it is stamped on every 0% line regardless, so the code is only right
    // for as long as every zero line is the thing the code names: M05 names an
    // export under art. 14, and an intra-EU sale is not one.
    const cc = String(o.shipping_address?.country_code ?? o.billing_address?.country_code ?? "").toUpperCase();
    const dest = !cc ? "?" : cc === "PT" ? "PT" : EU.has(cc) ? "UE" : "fora-UE";
    // Line items and built items are positionally unrelated (zero-priced lines
    // are dropped), so match on the name the builder stamped.
    const byName = new Map();
    for (const li of o.line_items ?? []) byName.set(String(li?.title ?? li?.name ?? "Item"), li);
    for (const it of items) {
      const isShip = /^Portes de envio/.test(String(it.name ?? ""));
      const raw = Number(it.tax?.value ?? it.tax ?? 0);
      const k = key(Number.isFinite(raw) ? raw : 0);
      (isShip ? shipRates : prodRates).set(k, ((isShip ? shipRates : prodRates).get(k) ?? 0) + 1);
      if (isShip) continue;
      if (parseFloat(k) === 0) zeroDest.set(dest, (zeroDest.get(dest) ?? 0) + 1);
      const li = byName.get(String(it.name ?? "").split(" / ")[0]) ?? byName.get(String(it.name ?? ""));
      const why = li ? whyRate(li, ovr, cfg) : "?";
      // The reduced rate hangs off the SKU being a well-formed ISBN-13. A digit
      // short, an ISBN-10, a stray letter, and the book silently bills at the
      // merch rate with nothing to show for it. Collect the near misses.
      const sku = String(li?.sku ?? "").replace(/[-\s]/g, "");
      if (ovr.get("RIOKO-ISBN-BOOK")?.tax_rate != null && parseFloat(k) > 6 && sku && !isIsbn13(sku)
          && (/^97[89]/.test(sku) || /^\d{9,14}[\dXx]?$/.test(sku))) {
        nearMiss.set(sku, `${sku} (${sku.length} digitos) ${String(it.name ?? "").slice(0, 44)}`);
      }
      const row = `${k.padEnd(5)} ${why.padEnd(34)} sku=${String(li?.sku ?? "").slice(0, 24).padEnd(24)} ${String(it.name ?? "").slice(0, 46)}`;
      detail.set(row, (detail.get(row) ?? 0) + 1);
    }
  }
  return { dom: shop.shopify_domain, cfg, overrides, httpErr, n, threw, shippingOrders, prodRates, shipRates, detail, nearMiss, zeroDest };
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
  // Portes a 23% sobre artigos a 6% ou isentos NAO e um achado: a taxa normal e
  // o defeito do transporte, e so se impoe outra quando o comerciante o declara.
  // O que importa e o par incompleto num regime que nao liquida nada: impor 0%
  // num dos dois campos e deixar o outro livre protege metade das linhas, e a
  // metade desprotegida so esta a zero enquanto a loja nao cobrar imposto.
  const exemptRegime = cfg.force_tax_rate === 0 || cfg.force_shipping_tax_rate === 0
    || ZERO_ONLY_CODES.has(String(cfg.ix_exemption_reason));
  if (exemptRegime && cfg.force_tax_rate === 0 && cfg.force_shipping_tax_rate == null) {
    out.push(`PAR INCOMPLETO: artigos impostos a 0% mas portes livres, logo 23% assim que a loja cobrar imposto no transporte (observado: ${[...r.shipRates.keys()].join(", ") || "-"})`);
  }
  if (exemptRegime && cfg.force_shipping_tax_rate === 0 && cfg.force_tax_rate == null) {
    out.push(`PAR INCOMPLETO: portes impostos a 0% mas artigos livres (observado: ${[...r.prodRates.keys()].join(", ") || "-"})`);
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
  const meansIt = CODE_MEANS[String(cfg.ix_exemption_reason)];
  if (meansIt) {
    const wrong = [...r.zeroDest.entries()].filter(([d, n]) => n > 0 && d !== meansIt.covers && d !== "?");
    const total = [...r.zeroDest.values()].reduce((a, b) => a + b, 0);
    if (wrong.length && total > 0) {
      out.push(`CODIGO NAO COBRE O DESTINO: ${cfg.ix_exemption_reason} e ${meansIt.gloss} (${meansIt.covers}), mas ha linhas a 0% para ${wrong.map(([d, n]) => `${d} x${n}`).join(", ")}`);
    }
  }
  if (r.nearMiss.size) {
    out.push(`ISBN QUASE VALIDO: ${r.nearMiss.size} SKU(s) falharam a regra do livro e sairam a taxa de merch -> ${[...r.nearMiss.values()].slice(0, 5).join(" | ")}`);
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
  if (r.zeroDest.size) console.log(`   linhas a 0% por destino: ${fmt(r.zeroDest)}`);
  const f = findings(r);
  if (f.length) flagged.push(r.dom);
  for (const line of f) console.log(`   ! ${line}`);
  if (process.env.DETAIL === "1") {
    console.log("   --- linhas por taxa e por regra ---");
    for (const [row, count] of [...r.detail.entries()].sort())
      console.log(`   ${String(count).padStart(4)}x ${row}`);
  }
  console.log("");
}
console.log(`RESUMO: ${flagged.length} de ${shops.length} lojas com parametros a rever: ${flagged.join(", ") || "nenhuma"}\n`);
