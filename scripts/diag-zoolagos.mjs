// Read-only incident diagnostic for zoolagos.myshopify.com "faturas por emitir".
// Replicates getReconciliation() outside the worker to find: (1) genuine unbilled
// orders (paid in Shopify, no invoice in DB), (2) phantom rate (invoice exists in
// DB but IX-proxy meta fetch flakes under parallel load). Secrets never printed.
import { execSync } from "node:child_process";

const SHOP = "zoolagos.myshopify.com";
const PROXY = "https://ix-proxy.kapta.app";
const wq = (sql) => {
  const raw = execSync(`npx wrangler d1 execute rioko-db --remote --json --command "${sql}"`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1))[0].results;
};

// 1. creds (not printed)
const cfg = wq(`SELECT ix_account_name AS acc, ix_api_key AS key, ix_environment AS env, shopify_token AS tok, shopify_api_version AS ver FROM integrations WHERE shopify_domain='${SHOP}'`)[0];
const ixH = { "x-account-name": cfg.acc, "x-api-key": cfg.key, "x-env": cfg.env === "production" ? "prod" : "dev", "Accept": "application/json" };
const ver = cfg.ver || "2026-01";
console.log(`ix acc=${cfg.acc} env=${cfg.env} shopVer=${ver}`);

// 2. processed_orders map (order_id -> invoice_id)
const proc = wq(`SELECT id AS oid, invoice_id AS inv, created_at AS ca FROM processed_orders WHERE shopify_domain='${SHOP}'`);
const procMap = new Map(proc.map(r => [String(r.oid), String(r.inv)]));
console.log(`processed_orders rows=${proc.length}`);

// 3. Shopify paid orders, last 90d
const FROM = "2026-03-11T00:00:00Z", TO = "2026-06-09T23:59:59Z";
async function shopifyPaid() {
  const all = [];
  let url = `https://${SHOP}/admin/api/${ver}/orders.json?processed_at_min=${encodeURIComponent(FROM)}&processed_at_max=${encodeURIComponent(TO)}&status=any&financial_status=paid&limit=250`;
  while (url) {
    const res = await fetch(url, { headers: { "X-Shopify-Access-Token": cfg.tok, "Accept": "application/json" } });
    if (!res.ok) throw new Error(`Shopify ${res.status}: ${(await res.text()).slice(0,200)}`);
    const d = await res.json();
    all.push(...d.orders);
    url = null;
    const lh = res.headers.get("Link");
    if (lh) { const m = lh.match(/<([^>]+)>;\s*rel="next"/); if (m) url = m[1]; }
  }
  return all;
}
const orders = await shopifyPaid();
console.log(`shopify paid orders (90d)=${orders.length}`);

// 4. genuine unbilled: paid order with no invoice_id in DB
const goLive = "2026-05-25T15:42:00Z";
const unbilled = orders.filter(o => !procMap.has(String(o.id)));
const unbilledAfter = unbilled.filter(o => (o.processed_at ?? o.created_at) >= goLive);
const unbilledBefore = unbilled.filter(o => (o.processed_at ?? o.created_at) < goLive);
console.log(`\n=== GENUINE UNBILLED (no invoice_id in DB) ===`);
console.log(`total=${unbilled.length}  before-golive(${goLive})=${unbilledBefore.length}  AFTER-golive=${unbilledAfter.length}`);
for (const o of unbilledAfter.slice(0, 40)) console.log(`  REAL-FAIL ${o.name} #${o.order_number} paid=${o.processed_at ?? o.created_at} total=${o.total_price} email=${o.email ?? o.customer?.email ?? "-"}`);

// 5. phantom test: burst-fetch invoice metas for in-window orders (replicate worker Promise.all)
const inWindowInv = orders.filter(o => procMap.has(String(o.id))).map(o => procMap.get(String(o.id)));
console.log(`\n=== PHANTOM TEST: ${inWindowInv.length} invoice metas via ${PROXY} ===`);
async function fetchMeta(id) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${PROXY}/v2/documents/${id}`, { headers: ixH });
    const ms = Date.now() - t0;
    let ok = false, body = "";
    if (r.ok) { try { const j = await r.json(); ok = !!(j?.data?.id || j?.data); } catch { ok = false; } }
    else body = (await r.text()).slice(0, 80);
    return { id, status: r.status, ok, ms, body };
  } catch (e) { return { id, status: 0, ok: false, ms: Date.now() - t0, body: String(e.message).slice(0,80) }; }
}
// BURST: all at once, exactly like getReconciliation's Promise.all
const burst = await Promise.all(inWindowInv.map(fetchMeta));
const dist = {};
for (const r of burst) dist[r.status] = (dist[r.status] || 0) + 1;
const burstFail = burst.filter(r => !r.ok);
console.log(`BURST status dist:`, JSON.stringify(dist));
console.log(`BURST failures (phantom 'por emitir')=${burstFail.length}/${burst.length}  maxMs=${Math.max(...burst.map(r=>r.ms))}`);
for (const r of burstFail.slice(0, 15)) console.log(`  PHANTOM inv=${r.id} status=${r.status} ${r.ms}ms ${r.body}`);

// 6. SEQUENTIAL re-check of burst failures: do these invoices actually exist?
console.log(`\n=== SEQUENTIAL re-check of ${burstFail.length} burst failures (capped) ===`);
let exist = 0, gone = 0;
for (const f of burstFail) {
  const r = await fetchMeta(f.id);
  if (r.ok) exist++; else { gone++; console.log(`  STILL-FAIL inv=${r.id} status=${r.status} ${r.body}`); }
}
console.log(`re-check: exist(=phantom, invoice IS in IX)=${exist}  still-fail=${gone}`);
console.log(`\nSUMMARY: realFailAfterGoLive=${unbilledAfter.length} phantomBurst=${burstFail.length} confirmedExistOnRetry=${exist}`);
