// Read-only: Shopify-side half of the zoolagos diagnostic. NO IX key used.
// Finds paid Shopify orders that have NO invoice_id row in processed_orders =
// the only GENUINE "faturas por emitir". Splits before/after go-live.
import { execSync } from "node:child_process";

const SHOP = "zoolagos.myshopify.com";
const wq = (sql) => {
  const raw = execSync(`npx wrangler d1 execute rioko-db --remote --json --command "${sql}"`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1))[0].results;
};

const cfg = wq(`SELECT shopify_token AS tok, shopify_api_version AS ver FROM integrations WHERE shopify_domain='${SHOP}'`)[0];
const ver = cfg.ver || "2026-01";

const proc = wq(`SELECT id AS oid, invoice_id AS inv FROM processed_orders WHERE shopify_domain='${SHOP}'`);
const withInv = new Set(proc.filter(r => r.inv).map(r => String(r.oid)));
console.log(`processed_orders with invoice_id=${withInv.size}`);

const FROM = "2026-03-11T00:00:00Z", TO = "2026-06-09T23:59:59Z";
const all = [];
let url = `https://${SHOP}/admin/api/${ver}/orders.json?processed_at_min=${encodeURIComponent(FROM)}&processed_at_max=${encodeURIComponent(TO)}&status=any&financial_status=paid&limit=250`;
while (url) {
  const res = await fetch(url, { headers: { "X-Shopify-Access-Token": cfg.tok, "Accept": "application/json" } });
  if (!res.ok) { console.error(`Shopify ${res.status}: ${(await res.text()).slice(0,200)}`); process.exit(1); }
  const d = await res.json();
  all.push(...d.orders);
  url = null;
  const lh = res.headers.get("Link");
  if (lh) { const m = lh.match(/<([^>]+)>;\s*rel="next"/); if (m) url = m[1]; }
}
console.log(`shopify paid orders (90d)=${all.length}`);

const goLive = "2026-05-25T15:42:00Z";
const unbilled = all.filter(o => !withInv.has(String(o.id)));
const after = unbilled.filter(o => (o.processed_at ?? o.created_at) >= goLive);
const before = unbilled.filter(o => (o.processed_at ?? o.created_at) < goLive);
console.log(`\n=== UNBILLED (paid, no invoice_id in DB) ===`);
console.log(`total=${unbilled.length}  pre-golive=${before.length}  POST-golive(REAL FAIL)=${after.length}`);
console.log(`\nPOST-GOLIVE genuine failures:`);
for (const o of after) console.log(`  ${o.name} #${o.order_number} paid=${o.processed_at ?? o.created_at} total=${o.total_price} ${o.financial_status} email=${o.email ?? o.customer?.email ?? "-"}`);
console.log(`\n(pre-golive sample, expected — integration not live yet):`);
for (const o of before.slice(0,10)) console.log(`  ${o.name} #${o.order_number} paid=${o.processed_at ?? o.created_at} total=${o.total_price}`);
