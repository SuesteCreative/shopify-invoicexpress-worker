// Read-only: dump the client-relevant fields for failed PT orders so we can see
// what makes IX say "Cliente/Fiscal não é válido". No writes.
import { execSync } from "node:child_process";
const SHOP = "zoolagos.myshopify.com";
const wq = (sql) => { const raw = execSync(`npx wrangler d1 execute rioko-db --remote --json --command "${sql}"`, { encoding: "utf8", maxBuffer: 64*1024*1024 }); return JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]")+1))[0].results; };
const cfg = wq(`SELECT shopify_token AS tok, shopify_api_version AS ver FROM integrations WHERE shopify_domain='${SHOP}'`)[0];
const ver = cfg.ver || "2026-01";
async function get(n){
  const r = await fetch(`https://${SHOP}/admin/api/${ver}/orders.json?name=${encodeURIComponent("#"+n)}&status=any&limit=1`, { headers:{ "X-Shopify-Access-Token":cfg.tok, "Accept":"application/json" }});
  const o=(await r.json()).orders?.[0]; if(!o) return console.log(`#${n}: not found`);
  const b=o.billing_address, c=o.customer;
  console.log(`\n#${o.order_number} ${o.name} -------------------------------------`);
  console.log(` email=${o.email} cust.email=${c?.email}`);
  console.log(` billing: ${b? JSON.stringify({name:b.name, company:b.company, country:b.country, country_code:b.country_code, province:b.province, city:b.city, zip:b.zip}) : "NULL"}`);
  console.log(` shipping_country=${o.shipping_address?.country}/${o.shipping_address?.country_code}`);
  console.log(` customer.default_address.country=${c?.default_address?.country}/${c?.default_address?.country_code}`);
  console.log(` note=${JSON.stringify(o.note)}`);
  console.log(` note_attributes=${JSON.stringify(o.note_attributes)}`);
  console.log(` customer.tax_exemptions=${JSON.stringify(c?.tax_exemptions)} tax_exempt=${c?.tax_exempt}`);
  console.log(` company=${JSON.stringify(o.company)}`);
}
for (const n of [1206,1037,1218,1229,1149,1188]) await get(n);
// one SUCCEEDED PT for contrast
console.log("\n===== SUCCEEDED PT for contrast =====");
for (const n of [1217,1190]) await get(n);
