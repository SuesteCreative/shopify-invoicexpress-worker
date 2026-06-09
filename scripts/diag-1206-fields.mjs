// Dump every field the NIF extractor + client builder read, for failed vs ok.
import { execSync } from "node:child_process";
const SHOP = "zoolagos.myshopify.com";
const wq = (sql) => { const raw = execSync(`npx wrangler d1 execute rioko-db --remote --json --command "${sql}"`, { encoding: "utf8", maxBuffer: 64*1024*1024 }); return JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]")+1))[0].results; };
const cfg = wq(`SELECT shopify_token AS tok, shopify_api_version AS ver FROM integrations WHERE shopify_domain='${SHOP}'`)[0];
const ver = cfg.ver || "2026-01";
// PT NIF checksum
function validPTNIF(n){ if(!/^\d{9}$/.test(n))return false; const d=n.split("").map(Number); if(![1,2,3,5,6,8,9].includes(d[0]))return false; let s=0; for(let i=0;i<8;i++)s+=d[i]*(9-i); const c=11-(s%11); const chk=c>=10?0:c; return chk===d[8]; }
const nineDigit = s => (String(s||"").match(/\d{9}/g)||[]);
async function get(n){
  const r=await fetch(`https://${SHOP}/admin/api/${ver}/orders.json?name=${encodeURIComponent("#"+n)}&status=any&limit=1`,{headers:{"X-Shopify-Access-Token":cfg.tok}});
  const o=(await r.json()).orders?.[0]; if(!o)return console.log(`#${n} not found`);
  const b=o.billing_address||{}, c=o.customer||{};
  const fields = { address1:b.address1, address2:b.address2, company:b.company, zip:b.zip, phone_cust:c.phone, phone_bill:b.phone, note:o.note };
  const found=[];
  for (const [k,v] of Object.entries(fields)) for (const m of nineDigit(v)) found.push(`${k}:${m}${validPTNIF(m)?"(VALID-NIF)":"(invalid)"}`);
  console.log(`#${o.order_number} ${o.financial_status} | 9-digit hits: [${found.join(", ")||"NONE"}]`);
  console.log(`     address1="${b.address1}" address2="${b.address2}" zip="${b.zip}" phone=${c.phone||b.phone}`);
}
console.log("=== FAILED ==="); for(const n of [1206,1218,1229,1149,1188,1037,1054,1070,1098]) await get(n);
console.log("=== OK (contrast) ==="); for(const n of [1217,1190,1205,1209,1210]) await get(n);
