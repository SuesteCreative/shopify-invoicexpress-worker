// Read-only: test whether the 26 failures are REPEAT customers whose IX client
// record (keyed by code=customer.id) was created earlier with a bad fiscal_id.
// Also dumps the full client object IX accepted on a working PT invoice.
import { execSync } from "node:child_process";
const SHOP = "zoolagos.myshopify.com", PROXY = "https://ix-proxy.kapta.app";
const wq = (sql) => { const raw = execSync(`npx wrangler d1 execute rioko-db --remote --json --command "${sql}"`, { encoding: "utf8", maxBuffer: 64*1024*1024 }); return JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]")+1))[0].results; };
const cfg = wq(`SELECT ix_account_name AS acc, ix_api_key AS key, ix_environment AS env, shopify_token AS tok, shopify_api_version AS ver FROM integrations WHERE shopify_domain='${SHOP}'`)[0];
const ixH = { "x-account-name": cfg.acc, "x-api-key": cfg.key, "x-env": cfg.env === "production" ? "prod" : "dev", "Accept":"application/json" };
const ver = cfg.ver || "2026-01";
const proc = wq(`SELECT id AS oid, invoice_id AS inv FROM processed_orders WHERE shopify_domain='${SHOP}'`);
const procMap = new Map(proc.filter(r=>r.inv).map(r => [String(r.oid), String(r.inv)]));

async function ordersByEmail(email){
  const r = await fetch(`https://${SHOP}/admin/api/${ver}/orders.json?email=${encodeURIComponent(email)}&status=any&limit=20`, { headers:{ "X-Shopify-Access-Token":cfg.tok }});
  return (await r.json()).orders||[];
}
async function getOrder(n){ const r=await fetch(`https://${SHOP}/admin/api/${ver}/orders.json?name=${encodeURIComponent("#"+n)}&status=any&limit=1`,{headers:{"X-Shopify-Access-Token":cfg.tok}}); return (await r.json()).orders?.[0]; }
async function doc(id){ try{ const r=await fetch(`${PROXY}/v2/documents/${id}`,{headers:ixH}); if(r.ok){const j=await r.json(); return j?.data;} }catch{} return null; }

console.log("=== Full client object IX ACCEPTED on working PT invoices ===");
for (const n of [1217,1190,1205]) {
  const o = await getOrder(n); const inv = procMap.get(String(o.id)); const d = await doc(inv);
  console.log(`#${n} client=${JSON.stringify(d?.client)}`);
}

console.log("\n=== Are the 26 REPEAT customers? prior invoiced order's client? ===");
for (const n of [1206,1218,1229,1149,1188,1037]) {
  const o = await getOrder(n);
  const email = o.email || o.customer?.email;
  const custId = o.customer?.id;
  const all = await ordersByEmail(email);
  const prior = all.filter(x => x.order_number !== n);
  let priorInvoiceInfo = "none";
  for (const p of prior) {
    const pinv = procMap.get(String(p.id));
    if (pinv) {
      const d = await doc(pinv);
      priorInvoiceInfo = `#${p.order_number} inv=${pinv} client.fiscal_id=${d?.client?.fiscal_id} client.code=${d?.client?.code} client.name=${d?.client?.name}`;
      break;
    }
  }
  console.log(`#${n} custId=${custId} email=${email} totalOrders=${all.length} priorInvoiced=[${priorInvoiceInfo}]`);
}
