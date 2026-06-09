// Read-only: list the IX account's configured taxes + inspect the tax lines IX
// accepted on a few SUCCEEDED PT-6% invoices. Helps tell data-bug vs proxy-blip.
import { execSync } from "node:child_process";
const SHOP = "zoolagos.myshopify.com", PROXY = "https://ix-proxy.kapta.app";
const wq = (sql) => { const raw = execSync(`npx wrangler d1 execute rioko-db --remote --json --command "${sql}"`, { encoding: "utf8", maxBuffer: 64*1024*1024 }); return JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]")+1))[0].results; };
const cfg = wq(`SELECT ix_account_name AS acc, ix_api_key AS key, ix_environment AS env, shopify_token AS tok, shopify_api_version AS ver FROM integrations WHERE shopify_domain='${SHOP}'`)[0];
const ixH = { "x-account-name": cfg.acc, "x-api-key": cfg.key, "x-env": cfg.env === "production" ? "prod" : "dev", "Accept": "application/json" };
const proc = wq(`SELECT id AS oid, invoice_id AS inv FROM processed_orders WHERE shopify_domain='${SHOP}'`);
const procMap = new Map(proc.filter(r=>r.inv).map(r => [String(r.oid), String(r.inv)]));
const ver = cfg.ver || "2026-01";

// taxes
const tr = await fetch(`${PROXY}/v2/taxes`, { headers: ixH });
console.log(`GET /v2/taxes -> ${tr.status}`);
try { const tj = await tr.json(); console.log(JSON.stringify(tj?.data ?? tj).slice(0,1200)); } catch { console.log((await tr.text()).slice(0,400)); }

// succeeded PT-6% invoices: #1217, #1145(DE 0%), #1230(FR 0%)
async function invByNum(n){
  const r = await fetch(`https://${SHOP}/admin/api/${ver}/orders.json?name=${encodeURIComponent("#"+n)}&status=any&limit=1`, { headers:{ "X-Shopify-Access-Token":cfg.tok }});
  const o=(await r.json()).orders?.[0]; return o?procMap.get(String(o.id)):null;
}
for (const n of [1217,1145,1230]) {
  const inv = await invByNum(n);
  if(!inv){console.log(`#${n}: no invoice_id`);continue;}
  const r = await fetch(`${PROXY}/v2/documents/${inv}`, { headers: ixH });
  const j = await r.json().catch(()=>null);
  const d = j?.data;
  const items = (d?.items||d?.lines||[]).map(it=>({desc:(it.description||it.name||"").slice(0,20), tax: it.tax?.name||it.tax_name||it.tax, val: it.tax?.value??it.tax_value, total: it.total||it.unit_price}));
  console.log(`#${n} inv=${inv} status=${r.status} doc.status=${d?.status} total=${d?.total} tax_total=${d?.taxes_total??d?.tax} client.country=${d?.client?.country} items=${JSON.stringify(items).slice(0,400)}`);
}
