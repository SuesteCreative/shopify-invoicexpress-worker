// Authoritative reconcile: classify EVERY paid order with a CAPPED+RETRY IX check
// (concurrency 5, 2 retries) so the check itself never phantoms. Tells the real
// number: confirmed-in-IX vs genuinely-unbilled vs DB-says-invoiced-but-IX-404.
import { execSync } from "node:child_process";
const SHOP = "zoolagos.myshopify.com", PROXY = "https://ix-proxy.kapta.app";
const wq = (sql) => { const raw = execSync(`npx wrangler d1 execute rioko-db --remote --json --command "${sql}"`, { encoding: "utf8", maxBuffer: 64*1024*1024 }); return JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]")+1))[0].results; };
const cfg = wq(`SELECT ix_account_name AS acc, ix_api_key AS key, ix_environment AS env, shopify_token AS tok, shopify_api_version AS ver FROM integrations WHERE shopify_domain='${SHOP}'`)[0];
const ixH = { "x-account-name": cfg.acc, "x-api-key": cfg.key, "x-env": cfg.env === "production" ? "prod" : "dev", "Accept": "application/json" };
const ver = cfg.ver || "2026-01";
const proc = wq(`SELECT id AS oid, invoice_id AS inv FROM processed_orders WHERE shopify_domain='${SHOP}'`);
const procMap = new Map(proc.filter(r=>r.inv).map(r => [String(r.oid), String(r.inv)]));

const FROM = "2026-03-11T00:00:00Z", TO = "2026-06-09T23:59:59Z";
const all = [];
let url = `https://${SHOP}/admin/api/${ver}/orders.json?processed_at_min=${encodeURIComponent(FROM)}&processed_at_max=${encodeURIComponent(TO)}&status=any&financial_status=paid&limit=250`;
while (url) { const res = await fetch(url, { headers: { "X-Shopify-Access-Token": cfg.tok, "Accept": "application/json" } }); const d = await res.json(); all.push(...d.orders); url=null; const lh=res.headers.get("Link"); if(lh){const m=lh.match(/<([^>]+)>;\s*rel="next"/); if(m)url=m[1];} }

async function ixExists(id) {
  for (let a=0;a<3;a++){
    try { const r = await fetch(`${PROXY}/v2/documents/${id}`, { headers: ixH });
      if (r.ok) { const j = await r.json(); if (j?.data) return { ok:true }; return { ok:false, why:"empty" }; }
      if (r.status===404) return { ok:false, why:"404" };
      // 5xx/429 → retry
    } catch {}
    await new Promise(r=>setTimeout(r, 400*(a+1)));
  }
  return { ok:false, why:"retry-exhausted" };
}
// capped pool of 5
async function pool(items, fn, n=5){ const out=[]; let i=0; const work=async()=>{ while(i<items.length){ const k=i++; out[k]=await fn(items[k],k);} }; await Promise.all(Array.from({length:n},work)); return out; }

const invoiced = all.filter(o => procMap.has(String(o.id)));
const unbilled = all.filter(o => !procMap.has(String(o.id)));
const goLive = "2026-05-25T15:42:00Z";
const realUnbilled = unbilled.filter(o => (o.processed_at??o.created_at) >= goLive);

console.log(`paid=${all.length} hasInvoiceId=${invoiced.length} noInvoiceId=${unbilled.length} (real post-golive=${realUnbilled.length})`);
console.log(`\nVerifying ${invoiced.length} IX docs (capped 5 + retry)...`);
const checks = await pool(invoiced, async (o)=>({ o, r: await ixExists(procMap.get(String(o.id))) }));
const confirmed = checks.filter(c=>c.r.ok);
const ghost = checks.filter(c=>!c.r.ok); // DB says invoiced but IX can't confirm even with retry
console.log(`CONFIRMED in IX=${confirmed.length}  UNCONFIRMED(after retry)=${ghost.length}`);
for (const g of ghost) console.log(`  UNCONFIRMED #${g.o.order_number} inv=${procMap.get(String(g.o.id))} why=${g.r.why}`);

// Spot-check the orders the user sees as "Sem fatura" on the page
const SCREEN = [1261,1260,1240,1230,1231,1206,1193,1170,1215,1228];
console.log(`\nScreenshot spot-check:`);
for (const n of SCREEN) {
  const o = all.find(x=>x.order_number===n);
  if (!o) { console.log(`  #${n}: not in paid window`); continue; }
  const inv = procMap.get(String(o.id));
  if (!inv) { console.log(`  #${n}: GENUINELY UNBILLED (no invoice_id)`); continue; }
  const r = await ixExists(inv);
  console.log(`  #${n}: invoice_id=${inv} IX=${r.ok?"EXISTS ✓ (page shows phantom)":"missing:"+r.why}`);
}
console.log(`\n=== TRUTH: realUnbilled=${realUnbilled.length}  confirmedInIX=${confirmed.length}  unconfirmed=${ghost.length} ===`);
console.log(`Real unbilled order numbers: ${realUnbilled.map(o=>o.order_number).sort((a,b)=>a-b).join(", ")}`);
