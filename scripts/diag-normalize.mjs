// Read-only: call the app's own normalize service for failed vs ok orders and
// dump the exact client-building inputs the IxBuilder receives (customer,
// billing, note_attributes, note, items/tax). This is the one transform the raw
// Shopify order doesn't show. No writes (normalize is a read transform).
import { execSync } from "node:child_process";
const SHOP = "zoolagos.myshopify.com";
const NORM = "https://endpoint-shopify.srv1250352.hstgr.cloud/orders/normalize";
const wq = (sql) => { const raw = execSync(`npx wrangler d1 execute rioko-db --remote --json --command "${sql}"`, { encoding: "utf8", maxBuffer: 64*1024*1024 }); return JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]")+1))[0].results; };
const cfg = wq(`SELECT shopify_token AS tok, shopify_api_version AS ver FROM integrations WHERE shopify_domain='${SHOP}'`)[0];
const NKEY = "2b752911-eb5a-4659-b353-f07a53a3680d"; // from wrangler.jsonc (plaintext var, not a secret)
const ver = cfg.ver || "2026-01";
function validPTNIF(n){ if(!/^\d{9}$/.test(String(n)))return false; const d=String(n).split("").map(Number); if(![1,2,3,5,6,8,9].includes(d[0]))return false; let s=0; for(let i=0;i<8;i++)s+=d[i]*(9-i); const c=11-(s%11); const chk=c>=10?0:c; return chk===d[8]; }

async function oid(num){ const r=await fetch(`https://${SHOP}/admin/api/${ver}/orders.json?name=${encodeURIComponent("#"+num)}&status=any&limit=1&fields=id`,{headers:{"X-Shopify-Access-Token":cfg.tok}}); return (await r.json()).orders?.[0]?.id; }
async function norm(num){
  const id = await oid(num); if(!id) return console.log(`#${num} no id`);
  const r = await fetch(`${NORM}/${id}`, { headers: { "x-api-key": NKEY, "shop-url": SHOP, "access-token": cfg.tok, "Accept":"application/json" }, signal: AbortSignal.timeout(20000) });
  if(!r.ok){ console.log(`#${num} normalize HTTP ${r.status}: ${(await r.text()).slice(0,160)}`); return; }
  const j = await r.json();
  const o = j?.normalized?.order ?? j?.order ?? j;
  const c = o?.customer||{}, b = o?.billing_address||{};
  console.log(`\n#${num} ----`);
  console.log(`  customer: ${JSON.stringify({id:c.id, name:c.name, email:c.email})}`);
  console.log(`  billing : ${JSON.stringify({name:b.name, company:b.company, address1:b.address1, address2:b.address2, country:b.country, country_code:b.country_code, zip:b.zip, phone:b.phone})}`);
  console.log(`  note=${JSON.stringify(o?.note)} note_attributes=${JSON.stringify(o?.note_attributes)} metafields=${JSON.stringify(o?.metafields)?.slice(0,200)}`);
  console.log(`  items.tax: ${JSON.stringify((o?.items||[]).map(it=>({t:it.title?.slice(0,12), tax:it.tax})))}`);
  // any 9-digit anywhere in the client blob
  const blob = JSON.stringify({c,b,note:o?.note,na:o?.note_attributes,mf:o?.metafields});
  const nines=[...new Set(blob.match(/\d{9}/g)||[])].map(n=>`${n}${validPTNIF(n)?"(VALID-NIF)":"(invalid)"}`);
  console.log(`  9-digit in client blob: [${nines.join(", ")||"none"}]`);
}
console.log("=== FAILED ==="); for(const n of [1206,1218,1149]) await norm(n);
console.log("\n=== OK ==="); for(const n of [1205,1217]) await norm(n);
