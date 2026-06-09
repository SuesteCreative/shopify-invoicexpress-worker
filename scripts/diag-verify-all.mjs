// Exhaustive verification of EVERY "sem fatura" candidate. Classifies all paid
// orders; for each invoice_id does capped+retry IX existence; resolves stubborn
// ones sequentially with 8 retries printing real HTTP status/body (404 = truly
// gone, 5xx/429 = proxy phantom). No writes.
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

async function ixCheck(id, attempts=4, base=400) {
  let last = { status: 0, body: "" };
  for (let a=0;a<attempts;a++){
    try { const r = await fetch(`${PROXY}/v2/documents/${id}`, { headers: ixH });
      if (r.ok) { const j = await r.json(); if (j?.data) return { ok:true, status:r.status }; last={status:r.status, body:"empty-data"}; }
      else { last = { status:r.status, body:(await r.text()).slice(0,120) }; if (r.status===404) return { ok:false, status:404, body:last.body }; }
    } catch(e){ last={status:0, body:String(e.message).slice(0,80)}; }
    await new Promise(r=>setTimeout(r, base*(a+1)));
  }
  return { ok:false, ...last };
}
async function pool(items, fn, n=4){ const out=[]; let i=0; const work=async()=>{ while(i<items.length){ const k=i++; out[k]=await fn(items[k]);} }; await Promise.all(Array.from({length:n},work)); return out; }

const goLive = "2026-05-25T15:42:00Z";
const invoiced = all.filter(o => procMap.has(String(o.id)));
const genuine = all.filter(o => !procMap.has(String(o.id)) && (o.processed_at??o.created_at) >= goLive);
const preGoLive = all.filter(o => !procMap.has(String(o.id)) && (o.processed_at??o.created_at) < goLive);

const checks = await pool(invoiced, async (o)=>({ o, r: await ixCheck(procMap.get(String(o.id))) }));
let confirmed = checks.filter(c=>c.r.ok);
let stubborn = checks.filter(c=>!c.r.ok);

// Resolve stubborn ones hard, sequentially, 8 retries
console.log(`First pass: confirmed=${confirmed.length} stubborn=${stubborn.length}. Resolving stubborn hard...`);
const trulyMissing = [], stillUnsure = [];
for (const c of stubborn) {
  const r = await ixCheck(procMap.get(String(c.o.id)), 8, 600);
  if (r.ok) confirmed.push(c);
  else if (r.status===404) trulyMissing.push({ n:c.o.order_number, inv:procMap.get(String(c.o.id)), body:r.body });
  else { stillUnsure.push({ n:c.o.order_number, inv:procMap.get(String(c.o.id)), status:r.status, body:r.body }); }
}

console.log(`\n================ VERIFIED TRUTH ================`);
console.log(`paid orders (90d)              : ${all.length}`);
console.log(`confirmed invoice EXISTS in IX : ${confirmed.length}`);
console.log(`GENUINELY UNBILLED (post-golive): ${genuine.length}`);
console.log(`pre-golive (no integration yet): ${preGoLive.length}  [${preGoLive.map(o=>o.order_number).sort((a,b)=>a-b).join(", ")}]`);
console.log(`TRULY MISSING in IX (404)      : ${trulyMissing.length}`);
console.log(`unverifiable (proxy 5xx/429)   : ${stillUnsure.length}`);

console.log(`\n--- GENUINELY UNBILLED (need re-emit) ---`);
for (const o of genuine.sort((a,b)=>a.order_number-b.order_number)) console.log(`  #${o.order_number} ${o.name} ${o.processed_at} ${o.total_price}€ ${o.email??o.customer?.email??"-"}`);
if (trulyMissing.length){ console.log(`\n--- TRULY MISSING (DB has id but IX 404 — investigate) ---`); for(const m of trulyMissing) console.log(`  #${m.n} inv=${m.inv} ${m.body}`); }
if (stillUnsure.length){ console.log(`\n--- UNVERIFIABLE (proxy error, likely exists) ---`); for(const m of stillUnsure) console.log(`  #${m.n} inv=${m.inv} status=${m.status} ${m.body}`); }
