// Read-only: authoritative list of issued invoices whose IX tax is 0%/Isento
// (should be 6% for a PT ticket office). Fetches each IX doc (capped 5), reports
// order#, invoice_id, reference, client country, doc status, total, and the VAT
// that should have been charged (6% of net). No writes.
import { execSync } from "node:child_process";
const SHOP = "zoolagos.myshopify.com", PROXY = "https://ix-proxy.kapta.app";
const wq = (sql) => { const raw = execSync(`npx wrangler d1 execute rioko-db --remote --json --command "${sql}"`, { encoding: "utf8", maxBuffer: 64*1024*1024 }); return JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]")+1))[0].results; };
const cfg = wq(`SELECT ix_account_name AS acc, ix_api_key AS key, ix_environment AS env, shopify_token AS tok, shopify_api_version AS ver FROM integrations WHERE shopify_domain='${SHOP}'`)[0];
const ixH = { "x-account-name": cfg.acc, "x-api-key": cfg.key, "x-env": cfg.env === "production" ? "prod" : "dev", "Accept": "application/json" };
const ver = cfg.ver || "2026-01";
const proc = wq(`SELECT id AS oid, invoice_id AS inv FROM processed_orders WHERE shopify_domain='${SHOP}'`);
const procMap = new Map(proc.filter(r=>r.inv).map(r => [String(r.oid), String(r.inv)]));

const all = [];
let url = `https://${SHOP}/admin/api/${ver}/orders.json?processed_at_min=${encodeURIComponent("2026-05-25T00:00:00Z")}&processed_at_max=${encodeURIComponent("2026-06-09T23:59:59Z")}&status=any&financial_status=paid&limit=250`;
while (url) { const res = await fetch(url, { headers: { "X-Shopify-Access-Token": cfg.tok, "Accept": "application/json" } }); const d = await res.json(); all.push(...d.orders); url=null; const lh=res.headers.get("Link"); if(lh){const m=lh.match(/<([^>]+)>;\s*rel="next"/); if(m)url=m[1];} }
const invoiced = all.filter(o => procMap.has(String(o.id)));

async function doc(id){ for(let a=0;a<3;a++){ try{ const r=await fetch(`${PROXY}/v2/documents/${id}`,{headers:ixH}); if(r.ok){const j=await r.json(); if(j?.data) return j.data;} }catch{} await new Promise(x=>setTimeout(x,400*(a+1))); } return null; }
async function pool(items, fn, n=5){ const out=[]; let i=0; const w=async()=>{ while(i<items.length){const k=i++; out[k]=await fn(items[k]);} }; await Promise.all(Array.from({length:n},w)); return out; }

const rows = await pool(invoiced, async (o)=>{
  const inv = procMap.get(String(o.id));
  const d = await doc(inv);
  if(!d) return { num:o.order_number, inv, err:"unreadable" };
  const items = d.items||d.lines||[];
  const taxes = items.map(it=> (typeof it.tax==="object"? (it.tax?.name||it.tax?.value) : it.tax));
  const isZero = items.length>0 && items.every(it=>{ const v = typeof it.tax==="object"? Number(it.tax?.value??0): Number(it.tax??0); const nm=(typeof it.tax==="object"?it.tax?.name:"")||""; return v===0 || /isent/i.test(nm); });
  return { num:o.order_number, inv, ref:d.reference, country:d.client?.country, status:d.status, total:Number(d.total??0), cc:o.billing_address?.country_code, taxes:[...new Set(taxes)].join("/"), isZero };
});

const wrong = rows.filter(r=>r.isZero && !r.err);
const unread = rows.filter(r=>r.err);
const ok6 = rows.filter(r=>!r.isZero && !r.err);
let vatOwed=0;
console.log(`invoiced=${invoiced.length}  at-6%(ok)=${ok6.length}  AT-0%/ISENTO(wrong)=${wrong.length}  unreadable=${unread.length}\n`);
console.log("--- WRONG (0%/Isento, should be 6%) ---");
console.log("#num    invoice_id   ref            country       status     total€   tax");
for (const r of wrong.sort((a,b)=>a.num-b.num)) {
  const net = r.total/1.06; const vat = r.total - net; vatOwed += vat;
  console.log(`#${String(r.num).padEnd(5)} ${String(r.inv).padEnd(11)} ${String(r.ref||"-").padEnd(14)} ${String(r.country||r.cc||"?").padEnd(12)} ${String(r.status||"?").padEnd(9)} ${r.total.toFixed(2).padStart(7)}  ${r.taxes}`);
}
console.log(`\nTotal bruto faturado errado: ${wrong.reduce((s,r)=>s+r.total,0).toFixed(2)}€`);
console.log(`IVA 6% que estaria embutido se corrigido (estimativa): ${vatOwed.toFixed(2)}€`);
console.log(`Status breakdown: ` + JSON.stringify(wrong.reduce((a,r)=>{a[r.status||"?"]=(a[r.status||"?"]||0)+1;return a;},{})));
if(unread.length) console.log(`Unreadable (proxy): ${unread.map(r=>"#"+r.num).join(", ")}`);
