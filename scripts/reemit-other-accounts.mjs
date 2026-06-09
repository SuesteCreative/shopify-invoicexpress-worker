// Recover the pre-fix unbilled orders on the OTHER real accounts (same DOC010/
// transient class as zoolagos). Per account: gate on the 1st order — only
// continue that account if it created/skipped. Resolves order_number from the
// order id, skips non-paid, never double-invoices (worker checks IX by ref).
import fs from "node:fs";
import { execSync } from "node:child_process";
const env = fs.readFileSync("backoffice/.env.local", "utf8");
const g = (k) => { const m = env.match(new RegExp("^" + k + "=(.*)$", "m")); return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : ""; };
const KEY = g("ADMIN_API_KEY"), W = g("WORKER_URL").replace(/\/$/, "");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const ACCOUNTS = {
  "fabrica-coffee-roaster.myshopify.com": ["8067913220443","8067913384283","8079701180763","8079701279067","8082819973467","8085221179739","8109901906267","8113416601947","8115435667803","8117005156699","8120702665051","8122128269659"],
  "2d0604-3.myshopify.com": ["13149255827842","13157264884098","13161642328450","13162388619650","13163061543298","13164860473730","13165952270722","13177461571970","13198832992642","13203825623426","13206285189506","13207634870658"],
  "mwi1cr-7t.myshopify.com": ["7958361899354","7966578737498","7970285519194"],
};

function shopCfg(shop) {
  const sql = `SELECT shopify_token AS t, shopify_api_version AS v FROM integrations WHERE shopify_domain='${shop}'`;
  const raw = execSync(`npx wrangler d1 execute rioko-db --remote --json --command "${sql}"`, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const row = JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1))[0].results[0];
  return { token: row.t, ver: row.v || "2026-01" };
}
async function orderInfo(shop, token, ver, id) {
  const r = await fetch(`https://${shop}/admin/api/${ver}/orders/${id}.json?fields=id,name,order_number,financial_status`, { headers: { "X-Shopify-Access-Token": token } });
  if (!r.ok) return { err: `shopify ${r.status}` };
  const o = (await r.json()).order;
  return o ? { name: o.name, num: o.order_number, paid: o.financial_status === "paid" } : { err: "not found" };
}
async function reemit(shop, num) {
  const r = await fetch(`${W}/admin/reemit-order`, { method: "POST", headers: { "x-api-key": KEY, "content-type": "application/json" }, body: JSON.stringify({ shop, order_number: num, reason: "incident sweep: pre-fix unbilled recovery", triggered_by: "claude-incident" }) });
  const j = await r.json().catch(() => ({}));
  return { status: j.status ?? j.result?.status ?? `http${r.status}`, message: (j.message ?? j.result?.message ?? j.error ?? "").slice(0, 160) };
}

(async () => {
  const totals = { created: 0, skipped: 0, failed: 0, notpaid: 0 };
  for (const [shop, ids] of Object.entries(ACCOUNTS)) {
    console.log(`\n========== ${shop} (${ids.length}) ==========`);
    let cfg; try { cfg = shopCfg(shop); } catch (e) { console.log(`  config error: ${e.message}`); continue; }
    let gated = false;
    for (let idx = 0; idx < ids.length; idx++) {
      const info = await orderInfo(shop, cfg.token, cfg.ver, ids[idx]);
      if (info.err) { console.log(`  id ${ids[idx]}: SKIP (${info.err})`); continue; }
      if (!info.paid) { console.log(`  ${info.name}: SKIP (não paga)`); totals.notpaid++; continue; }
      const res = await reemit(shop, info.num);
      console.log(`  ${info.name} (#${info.num}): ${res.status} — ${res.message}`);
      if (res.status === "created") totals.created++;
      else if (res.status === "skipped") totals.skipped++;
      else { totals.failed++;
        if (!gated && idx === 0) { console.log(`  >>> GATE da conta ${shop} falhou — paro esta conta. Investigar.`); break; }
      }
      gated = true;
      await sleep(800);
    }
  }
  console.log(`\n=== TOTAL: created=${totals.created} skipped=${totals.skipped} notpaid=${totals.notpaid} failed=${totals.failed} ===`);
})();
