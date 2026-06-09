// Read-only: does "multi line-item" vs "single" split the 26 failures from the
// successes? Counts line_items + distinct tax rates per order. Shopify only.
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

const isPT6 = (o) => { const t=(o.tax_lines||[])[0]; return (o.billing_address?.country_code==="PT") && t && Math.round(Number(t.rate)*100)===6; };
const pt6 = all.filter(isPT6);
function bucket(o){ return { items: (o.line_items||[]).length, qty:(o.line_items||[]).reduce((s,li)=>s+Number(li.quantity||0),0), inv: has.has(String(o.id)) }; }
const fail = pt6.filter(o=>!has.has(String(o.id))).map(bucket);
const ok = pt6.filter(o=>has.has(String(o.id))).map(bucket);
const dist = arr => arr.reduce((a,b)=>{a[b.items]=(a[b.items]||0)+1;return a;},{});
console.log(`PT-6% FAILED (${fail.length}) line_items distribution:`, JSON.stringify(dist(fail)));
console.log(`PT-6% OK     (${ok.length}) line_items distribution:`, JSON.stringify(dist(ok)));
console.log(`\nFAILED multi-item(>1): ${fail.filter(b=>b.items>1).length}/${fail.length}`);
console.log(`OK     multi-item(>1): ${ok.filter(b=>b.items>1).length}/${ok.length}`);
console.log(`FAILED qty>1 (single line, multi qty): ${fail.filter(b=>b.items===1&&b.qty>1).length}`);
console.log(`OK     qty>1 (single line, multi qty): ${ok.filter(b=>b.items===1&&b.qty>1).length}`);
