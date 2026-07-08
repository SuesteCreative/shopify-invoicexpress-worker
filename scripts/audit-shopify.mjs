// Shopify→IX INTEGRATION HEALTH AUDIT (read-only, zero writes, zero IX footprint).
//
// Generalizes healthcheck.mjs: instead of 4 hardcoded shops it enumerates EVERY
// live Shopify→IX integration from D1, then for each shop runs a battery of
// read-only health signals:
//   1. config sanity      — token + IX creds present, behaviour flags
//   2. Shopify token live  — GET /shop.json (401/403 = dead token = silent break)
//   3. invoice drift       — real bundled IxBuilder, paid orders, 1¢ tolerance
//   4. unprocessed orders  — paid Shopify order with no invoice_id in processed_orders
//   5. processing freshness— newest paid order vs last processed_orders row
//   6. open incidents      — incidents table (open/acknowledged), by severity
//   7. webhook failures    — webhook_info state='failed' inside the window
//
// NO INSERT/UPDATE/DELETE anywhere. NO IX API call (builder runs in-process,
// its guards are exercised but nothing is sent). Secrets stay in-process — output
// prints only shop domains, order numbers and monetary values.
//
//   DAYS=30 node scripts/audit-shopify.mjs
import { execSync } from "node:child_process";
import { IxBuilder } from "./.gen/builder.mjs";

const DAYS = Number(process.env.DAYS ?? 30);
const SINCE_MS = Date.now() - DAYS * 864e5;
const SINCE_ISO = new Date(SINCE_MS).toISOString();
// Orders older than this that are still uninvoiced are a real failure; younger
// ones are likely still in-flight (Shopify enqueues with delaySeconds:120 + retries).
const INFLIGHT_H = Number(process.env.INFLIGHT_H ?? 24);

// Mute the builder's internal console.log/error ([NIF] traces etc.).
const _log = console.log, _err = console.error;
const mute = () => { console.log = () => {}; console.error = () => {}; };
const unmute = () => { console.log = _log; console.error = _err; };

const wq = (sql) => {
  const raw = execSync(`npx wrangler d1 execute rioko-db --remote --json --command "${sql}"`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1))[0].results;
};

// Full per-shop config (secrets used in-process, never logged). Mirrors healthcheck.mjs.
function loadConfig(dom) {
  const cols = [
    "user_id", "shopify_domain", "shopify_token", "shopify_api_version",
    "ix_account_name", "ix_api_key", "ix_environment", "ix_document_type",
    "ix_exemption_reason", "ix_b2b_exemption_reason",
    "force_tax_rate", "force_shipping_tax_rate", "vat_included", "oss_enabled",
    "b2b_reverse_charge", "auto_finalize", "pos_mode",
    "ix_retention_enabled", "ix_retention", "is_paused",
  ];
  const r = wq(`SELECT ${cols.join(", ")} FROM integrations WHERE shopify_domain='${dom}'`)[0];
  for (const k of ["force_tax_rate", "force_shipping_tax_rate", "vat_included", "oss_enabled", "b2b_reverse_charge", "auto_finalize", "pos_mode", "ix_retention_enabled", "ix_retention", "is_paused"]) {
    r[k] = r[k] == null ? null : Number(r[k]);
  }
  return r;
}

async function checkToken(cfg) {
  const ver = cfg.shopify_api_version || "2026-01";
  try {
    const res = await fetch(`https://${cfg.shopify_domain}/admin/api/${ver}/shop.json`, {
      headers: { "X-Shopify-Access-Token": cfg.shopify_token, "Accept": "application/json" },
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, err: String(e?.message ?? e).slice(0, 80) };
  }
}

async function fetchPaidOrders(cfg) {
  const ver = cfg.shopify_api_version || "2026-01";
  let url = `https://${cfg.shopify_domain}/admin/api/${ver}/orders.json?status=any&financial_status=paid&processed_at_min=${encodeURIComponent(SINCE_ISO)}&limit=250`;
  const out = [];
  let pages = 0, httpErr = null;
  while (url && pages < 3) {
    const res = await fetch(url, { headers: { "X-Shopify-Access-Token": cfg.shopify_token, "Accept": "application/json" } });
    if (!res.ok) { httpErr = res.status; break; }
    const d = await res.json();
    out.push(...(d.orders ?? []));
    pages++;
    url = null;
    const lh = res.headers.get("Link");
    if (lh) { const m = lh.match(/<([^>]+)>;\s*rel="next"/); if (m) url = m[1]; }
  }
  return { orders: out, httpErr };
}

function toNormalized(raw) {
  return {
    order: {
      id: raw.id, order_number: raw.order_number, created_at: raw.created_at,
      customer: raw.customer ?? {}, billing_address: raw.billing_address ?? {},
      shipping_address: raw.shipping_address ?? {}, note: raw.note ?? null,
      note_attributes: raw.note_attributes ?? [], items: [],
    },
    raw_order: raw,
  };
}

// ---- one-shot global reads (grouped in JS) ---------------------------------
function loadShops() {
  return wq(
    "SELECT user_id, shopify_domain, is_paused, ix_environment, ix_document_type, shopify_api_version " +
    "FROM integrations WHERE shopify_domain IS NOT NULL AND shopify_token IS NOT NULL AND ix_api_key IS NOT NULL " +
    "ORDER BY shopify_domain"
  );
}
function loadIncidents() {
  try {
    return wq(
      "SELECT COALESCE(user_id,'') user_id, severity, kind, COUNT(*) c, COALESCE(SUM(occurrences),0) occ, MAX(last_seen_at) last " +
      "FROM incidents WHERE status IN ('open','acknowledged') GROUP BY user_id, severity, kind"
    );
  } catch { return []; }
}
function loadWebhookFails() {
  try {
    return wq(
      `SELECT COALESCE(shopify_domain,'') dom, COALESCE(user_id,'') user_id, topic, COUNT(*) c, MAX(created_at) last ` +
      `FROM webhook_info WHERE state='failed' AND created_at >= '${SINCE_ISO}' GROUP BY shopify_domain, user_id, topic`
    );
  } catch { return []; }
}
// Processed order ids for a shop (bounded query text). 7d buffer so orders
// invoiced just before the window edge still count as processed.
function loadProcessed(dom) {
  const since = new Date(SINCE_MS - 7 * 864e5).toISOString();
  const rows = wq(`SELECT id, invoice_id, created_at FROM processed_orders WHERE shopify_domain='${dom}' AND created_at >= '${since}'`);
  const withInvoice = new Set();
  let lastAt = null;
  for (const r of rows) {
    if (r.invoice_id) withInvoice.add(String(r.id));
    if (!lastAt || r.created_at > lastAt) lastAt = r.created_at;
  }
  return { withInvoice, lastAt, total: rows.length };
}

const r2 = (n) => Math.round(n * 100) / 100;

async function checkShop(shop, incByUser, whByShop) {
  const dom = shop.shopify_domain;
  const cfg = loadConfig(dom);
  const builder = new IxBuilder(cfg);

  const tok = await checkToken(cfg);
  let orders = [], httpErr = null;
  if (tok.ok) { const f = await fetchPaidOrders(cfg); orders = f.orders; httpErr = f.httpErr; }

  const proc = tok.ok ? loadProcessed(dom) : { withInvoice: new Set(), lastAt: null, total: 0 };

  const driftRows = [], unprocessed = [];
  let foreign = 0, withNif = 0, discounted = 0, multiline = 0, zero = 0, threw = 0, newestOrderAt = null;

  for (const o of orders) {
    const total = Number(o.total_price);
    if (o.created_at && (!newestOrderAt || o.created_at > newestOrderAt)) newestOrderAt = o.created_at;
    const cc = String(o.billing_address?.country_code ?? "").toUpperCase();
    const isForeign = cc && cc !== "PT";
    const hasDisc = Number(o.total_discounts ?? 0) > 0 || (o.line_items ?? []).some(li => (li.discount_allocations ?? []).length > 0);
    const nLines = (o.line_items ?? []).filter(li => Number(li.price) > 0).length;

    if (!Number.isFinite(total) || total <= 0) { zero++; continue; }
    if (isForeign) foreign++;
    if (hasDisc) discounted++;
    if (nLines > 1) multiline++;

    // Unprocessed = paid, non-zero order with no invoice_id recorded in D1.
    if (!proc.withInvoice.has(String(o.id))) {
      const ageH = (Date.now() - new Date(o.created_at).getTime()) / 36e5;
      unprocessed.push({ n: o.order_number, total: total.toFixed(2), ageH, inflight: ageH < INFLIGHT_H });
    }

    // Drift: run the REAL builder path exactly as healthcheck does.
    let expected = null, guardThrew = false, errMsg = "", fiscal = null;
    mute();
    try {
      const items = builder.buildInvoiceItemsFromRaw(o);
      expected = builder.computeIxExpectedTotal(items);
      const client = builder.buildInvoiceClient(toNormalized(o));
      fiscal = client.fiscal_id ?? null;
    } catch (e) { errMsg = String(e?.message ?? e).slice(0, 140); }
    try { builder.createInvoiceFromNormalizedOrder(toNormalized(o)); }
    catch (e) { guardThrew = true; if (!errMsg) errMsg = String(e?.message ?? e).slice(0, 200); }
    unmute();

    if (fiscal) withNif++;
    const d = expected == null ? Infinity : Math.abs(expected - total);
    const bad = guardThrew || d > 0.01;
    if (guardThrew) threw++;
    if (bad) driftRows.push({ n: o.order_number, total: total.toFixed(2), exp: expected == null ? "ERR" : expected.toFixed(2), d: Number.isFinite(d) ? d.toFixed(2) : "ERR", cc: cc || "PT", disc: hasDisc ? "D" : "", nLines, err: errMsg });
  }

  const inc = incByUser.get(shop.user_id) ?? [];
  const wh = whByShop.get(dom) ?? (whByShop.get("@" + shop.user_id) ?? []);
  const staleUnprocessed = unprocessed.filter(u => !u.inflight);
  const critIncidents = inc.filter(i => i.severity === "error" || i.severity === "critical");

  return {
    dom, cfg, shop, tok, httpErr, n: orders.length, zero, foreign, withNif, discounted, multiline,
    drift: driftRows.length, threw, driftRows,
    unprocessed, staleUnprocessed, inflightUnprocessed: unprocessed.length - staleUnprocessed.length,
    proc, newestOrderAt, inc, critIncidents, wh,
  };
}

function verdict(r) {
  const paused = r.cfg.is_paused === 1;
  if (!r.tok.ok) return "FAIL";
  if (r.httpErr) return "FAIL";
  if (r.drift > 0) return "FAIL";
  if (!paused && r.staleUnprocessed.length > 0) return "FAIL";
  if (r.critIncidents.length > 0) return "FAIL";
  if (r.inflightUnprocessed > 0 || r.inc.length > 0 || r.wh.length > 0 || (paused && r.unprocessed.length > 0)) return "WARN";
  return "OK";
}

// ------------------------------------------------------------------- main ----
console.log(`\n=== Shopify→IX INTEGRATION HEALTH AUDIT (last ${DAYS}d paid, real builder, NO writes) ===`);
console.log(`Window since ${SINCE_ISO}  ·  in-flight grace ${INFLIGHT_H}h\n`);

const shops = loadShops();
console.log(`Enumerated ${shops.length} live Shopify→IX integrations from D1.\n`);

// group global reads
const incByUser = new Map();
for (const row of loadIncidents()) { const k = row.user_id; if (!incByUser.has(k)) incByUser.set(k, []); incByUser.get(k).push(row); }
const whByShop = new Map();
for (const row of loadWebhookFails()) {
  const kd = row.dom, ku = "@" + row.user_id;
  if (kd) { if (!whByShop.has(kd)) whByShop.set(kd, []); whByShop.get(kd).push(row); }
  else { if (!whByShop.has(ku)) whByShop.set(ku, []); whByShop.get(ku).push(row); }
}

const results = [];
for (const shop of shops) {
  process.stdout.write(`Checking ${shop.shopify_domain} ... `);
  try {
    const r = await checkShop(shop, incByUser, whByShop);
    results.push(r);
    console.log(`${r.tok.ok ? r.n + " paid orders" : "TOKEN " + (r.tok.status || r.tok.err)}`);
    const paused = r.cfg.is_paused === 1 ? "  [PAUSED]" : "";
    console.log(`  profile: env=${r.cfg.ix_environment} doctype=${r.cfg.ix_document_type} vat_incl=${r.cfg.vat_included} force_tax=${r.cfg.force_tax_rate ?? "-"} force_ship=${r.cfg.force_shipping_tax_rate ?? "-"} pos=${r.cfg.pos_mode} auto_final=${r.cfg.auto_finalize}${paused}`);
    console.log(`  token:   ${r.tok.ok ? "OK (200)" : "DEAD (" + (r.tok.status || r.tok.err) + ")"}${r.httpErr ? "  orders HTTP " + r.httpErr : ""}`);
    if (r.tok.ok) {
      console.log(`  orders:  paid=${r.n} zero=${r.zero} foreign=${r.foreign} discounted=${r.discounted} multiline=${r.multiline} nif_stamped=${r.withNif}`);
      console.log(`  drift:   ${r.drift} order(s) would NOT invoice cleanly (guard-threw=${r.threw})`);
      for (const x of r.driftRows.slice(0, 15)) console.log(`      #${x.n} paid=${x.total} ixExpected=${x.exp} drift=${x.d} ${x.cc}${x.disc ? " " + x.disc : ""}${x.nLines > 1 ? ` lines=${x.nLines}` : ""}${x.err ? "  | " + x.err : ""}`);
      if (r.driftRows.length > 15) console.log(`      ... +${r.driftRows.length - 15} more`);
      console.log(`  unbilled: ${r.staleUnprocessed.length} paid>${INFLIGHT_H}h with no invoice${r.inflightUnprocessed ? ` (+${r.inflightUnprocessed} in-flight <${INFLIGHT_H}h)` : ""}`);
      for (const u of r.staleUnprocessed.slice(0, 15)) console.log(`      #${u.n} paid=${u.total} age=${Math.round(u.ageH)}h  NO INVOICE`);
      if (r.staleUnprocessed.length > 15) console.log(`      ... +${r.staleUnprocessed.length - 15} more`);
      console.log(`  fresh:   last processed=${r.proc.lastAt ?? "never"}  newest paid order=${r.newestOrderAt ?? "-"}  (processed rows in window+7d: ${r.proc.total})`);
    }
    if (r.inc.length) {
      console.log(`  incidents(open): ${r.inc.reduce((a, i) => a + i.c, 0)} across ${r.inc.length} bucket(s)`);
      for (const i of r.inc.slice(0, 8)) console.log(`      [${i.severity}] ${i.kind} x${i.c} (occ ${i.occ}) last ${i.last}`);
    }
    if (r.wh.length) {
      console.log(`  webhook-fails(${DAYS}d): ${r.wh.reduce((a, w) => a + w.c, 0)} across topics`);
      for (const w of r.wh.slice(0, 8)) console.log(`      ${w.topic} x${w.c} last ${w.last}`);
    }
    console.log(`  VERDICT: ${verdict(r)}`);
  } catch (e) {
    results.push({ dom: shop.shopify_domain, error: String(e?.message ?? e).slice(0, 200), cfg: {}, tok: { ok: false }, drift: 0, staleUnprocessed: [], inflightUnprocessed: 0, inc: [], critIncidents: [], wh: [] });
    console.log(`ERROR: ${String(e?.message ?? e).slice(0, 200)}`);
  }
  console.log("");
}

// ------------------------------------------------------------------ summary ---
console.log("================ SUMMARY ================");
let dead = 0, drift = 0, unbilled = 0, critInc = 0, fails = 0, warns = 0;
for (const r of results) {
  const v = r.error ? "ERROR" : verdict(r);
  if (v === "FAIL" || v === "ERROR") fails++;
  if (v === "WARN") warns++;
  if (r.tok && !r.tok.ok) dead++;
  drift += r.drift ?? 0;
  unbilled += (r.staleUnprocessed?.length ?? 0);
  critInc += (r.critIncidents?.length ?? 0);
  const paused = r.cfg?.is_paused === 1 ? " [paused]" : "";
  const bits = [];
  if (r.tok && !r.tok.ok) bits.push(`token=${r.tok.status || "dead"}`);
  if (r.drift) bits.push(`drift=${r.drift}`);
  if (r.staleUnprocessed?.length) bits.push(`unbilled=${r.staleUnprocessed.length}`);
  if (r.inflightUnprocessed) bits.push(`inflight=${r.inflightUnprocessed}`);
  if (r.critIncidents?.length) bits.push(`incidents=${r.critIncidents.length}`);
  if (r.wh?.length) bits.push(`whfail=${r.wh.reduce((a, w) => a + w.c, 0)}`);
  if (r.error) bits.push(`err`);
  console.log(`  ${v.padEnd(6)} ${r.dom.padEnd(34)}${paused} ${bits.join(" ")}`);
}
console.log("-----------------------------------------");
console.log(`  shops=${results.length}  OK=${results.length - fails - warns}  WARN=${warns}  FAIL=${fails}`);
console.log(`  dead-tokens=${dead}  drift-orders=${drift}  unbilled(>${INFLIGHT_H}h)=${unbilled}  open-error/critical-incident-buckets=${critInc}`);
console.log(`\nAudit complete. Read-only: no writes, no IX calls.`);
