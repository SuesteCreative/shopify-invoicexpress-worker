// Read-only: compare failed vs succeeded zoolagos orders on the fields the
// June-2 IX builder change touched (billing country / country_code, NIF, tax).
// Shopify GET only. NO IX key.
import { execSync } from "node:child_process";
const SHOP = "zoolagos.myshopify.com";
const wq = (sql) => { const raw = execSync(`npx wrangler d1 execute rioko-db --remote --json --command "${sql}"`, { encoding: "utf8", maxBuffer: 64*1024*1024 }); return JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]")+1))[0].results; };
const cfg = wq(`SELECT shopify_token AS tok, shopify_api_version AS ver FROM integrations WHERE shopify_domain='${SHOP}'`)[0];
const ver = cfg.ver || "2026-01";
const H = { "X-Shopify-Access-Token": cfg.tok, "Accept": "application/json" };

const FAILED = [1037,1054,1070,1098,1146,1229];      // sample of the 26
const OK = [1230,1231,1228,1217,1145];               // neighbours that should have succeeded
async function getOrder(num) {
  const r = await fetch(`https://${SHOP}/admin/api/${ver}/orders.json?name=${encodeURIComponent("#"+num)}&status=any&limit=1`, { headers: H });
  if (!r.ok) return { num, err: `${r.status}` };
  const o = (await r.json()).orders?.[0];
  if (!o) return { num, err: "not found" };
  const b = o.billing_address || null, s = o.shipping_address || null;
  const nifAttr = (o.note_attributes||[]).map(a=>`${a.name}=${a.value}`).join("; ");
  return {
    num: o.order_number, name: o.name, fin: o.financial_status,
    bill_country: b?.country ?? null, bill_cc: b?.country_code ?? null, bill_company: b?.company ?? null,
    ship_country: s?.country ?? null, ship_cc: s?.country_code ?? null,
    has_billing: !!b, total: o.total_price, total_tax: o.total_tax, taxes_inc: o.taxes_included,
    tax_lines: (o.tax_lines||[]).map(t=>`${t.title}:${t.rate}`).join(","),
    li_tax: (o.line_items||[]).map(li=>(li.tax_lines||[]).map(t=>t.rate).join("/")).join(" | "),
    note_attrs: nifAttr || null, cust_nif: o.customer?.note ?? null,
  };
}
const fmt = (r) => r.err ? `#${r.num} ERR ${r.err}` :
  `#${r.num} ${r.fin} bill[country=${r.bill_country} cc=${r.bill_cc} co=${r.bill_company} present=${r.has_billing}] ship[${r.ship_country}/${r.ship_cc}] tax=${r.total_tax} inc=${r.taxes_inc} taxlines=${r.tax_lines} li_tax=[${r.li_tax}] notes=${r.note_attrs}`;
console.log("=== FAILED (no invoice) ===");
for (const n of FAILED) console.log("  " + fmt(await getOrder(n)));
console.log("=== SUCCEEDED (have invoice) ===");
for (const n of OK) console.log("  " + fmt(await getOrder(n)));
