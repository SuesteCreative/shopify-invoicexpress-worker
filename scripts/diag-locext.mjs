// Read-only: fetch Shopify localizationExtensions (where PT checkout NIF lives)
// + customer NIF-ish fields via GraphQL, for failed vs ok orders. This is the
// field the normalize service injects and the REST order does not surface.
import { execSync } from "node:child_process";
const SHOP = "zoolagos.myshopify.com";
const wq = (sql) => { const raw = execSync(`npx wrangler d1 execute rioko-db --remote --json --command "${sql}"`, { encoding: "utf8", maxBuffer: 64*1024*1024 }); return JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]")+1))[0].results; };
const cfg = wq(`SELECT shopify_token AS tok, shopify_api_version AS ver FROM integrations WHERE shopify_domain='${SHOP}'`)[0];
const ver = cfg.ver || "2026-01";
function validPTNIF(n){ if(!/^\d{9}$/.test(n))return false; const d=n.split("").map(Number); if(![1,2,3,5,6,8,9].includes(d[0]))return false; let s=0; for(let i=0;i<8;i++)s+=d[i]*(9-i); const c=11-(s%11); const chk=c>=10?0:c; return chk===d[8]; }

async function orderGID(num){
  const r=await fetch(`https://${SHOP}/admin/api/${ver}/orders.json?name=${encodeURIComponent("#"+num)}&status=any&limit=1&fields=id`,{headers:{"X-Shopify-Access-Token":cfg.tok}});
  const o=(await r.json()).orders?.[0]; return o? `gid://shopify/Order/${o.id}` : null;
}
async function gql(gid){
  const q=`query{ order(id:"${gid}"){ name localizationExtensions(first:10){ edges{ node{ purpose title value countryCode } } } customer{ taxExempt } billingAddress{ company } } }`;
  const r=await fetch(`https://${SHOP}/admin/api/${ver}/graphql.json`,{method:"POST",headers:{"X-Shopify-Access-Token":cfg.tok,"Content-Type":"application/json"},body:JSON.stringify({query:q})});
  return (await r.json());
}
async function show(num){
  const gid=await orderGID(num); if(!gid)return console.log(`#${num} not found`);
  const j=await gql(gid);
  const o=j?.data?.order;
  const exts=(o?.localizationExtensions?.edges||[]).map(e=>`${e.node.purpose}/${e.node.title}=${e.node.value}${/^\d{9}$/.test(e.node.value)?(validPTNIF(e.node.value)?"(VALID-NIF)":"(INVALID-NIF)"):""}`);
  if(j.errors) return console.log(`#${num} GQL errors: ${JSON.stringify(j.errors).slice(0,200)}`);
  console.log(`#${num} localizationExtensions=[${exts.join(" | ")||"none"}]`);
}
console.log("=== FAILED ==="); for(const n of [1206,1218,1229,1149,1188,1037,1054]) await show(n);
console.log("=== OK ==="); for(const n of [1217,1205,1209,1210]) await show(n);
