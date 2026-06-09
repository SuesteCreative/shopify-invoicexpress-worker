// Read-only: timeline of every paid order — date, country, VAT rate, invoiced?
// Tests whether the 26 failures are exactly the PT-6% orders inside one window.
import { execSync } from "node:child_process";
const SHOP = "zoolagos.myshopify.com";
const wq = (sql) => { const raw = execSync(`npx wrangler d1 execute rioko-db --remote --json --command "${sql}"`, { encoding: "utf8", maxBuffer: 64*1024*1024 }); return JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]")+1))[0].results; };
const cfg = wq(`SELECT shopify_token AS tok, shopify_api_version AS ver FROM integrations WHERE shopify_domain='${SHOP}'`)[0];
const ver = cfg.ver || "2026-01";
const proc = wq(`SELECT id AS oid, invoice_id AS inv FROM processed_orders WHERE shopify_domain='${SHOP}'`);
const has = new Set(proc.filter(r=>r.inv).map(r => String(r.oid)));
const all = [];
let url = `https://${SHOP}/admin/api/${ver}/orders.json?processed_at_min=${encodeURIComponent("2026-05-25T00:00:00Z")}&processed_at_max=${encodeURIComponent("2026-06-09T23:59:59Z")}&status=any&financial_status=paid&limit=250`;
while (url) { const res = await fetch(url, { headers: { "X-Shopify-Access-Token": cfg.tok, "Accept": "application/json" } }); const d = await res.json(); all.push(...d.orders); url=null; const lh=res.headers.get("Link"); if(lh){const m=lh.match(/<([^>]+)>;\s*rel="next"/); if(m)url=m[1];} }
const rate = (o) => { const t=(o.tax_lines||[])[0]; return t? Math.round(Number(t.rate)*100) : 0; };
all.sort((a,b)=>Date.parse(a.processed_at||a.created_at)-Date.parse(b.processed_at||b.created_at));
console.log("date                 #num   cc   vat%  invoiced");
let ptFail=0, ptOk=0, foreignFail=0;
for (const o of all) {
  const cc=o.billing_address?.country_code||"?"; const r=rate(o); const inv=has.has(String(o.id));
  if(!inv && cc==="PT" && r===6) ptFail++;
  if(inv && cc==="PT" && r===6) ptOk++;
  if(!inv && !(cc==="PT"&&r===6)) foreignFail++;
  const mark = !inv ? " <== NO INVOICE" : "";
  console.log(`${(o.processed_at||o.created_at).slice(0,16)}  #${o.order_number}  ${cc.padEnd(3)}  ${String(r).padStart(3)}   ${inv?"yes":"NO "}${mark}`);
}
console.log(`\nPT-6% failed=${ptFail}  PT-6% ok=${ptOk}  non-PT6%-failed=${foreignFail}`);
