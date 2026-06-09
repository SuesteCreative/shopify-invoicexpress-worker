// One-off recovery: reemit unbilled orders via the worker /admin/reemit-order.
// Reads ADMIN_API_KEY + WORKER_URL from backoffice/.env.local; resolves each
// order's number from Shopify (shop token pulled from prod D1 via wrangler).
// Usage: node scripts/recover-reemit.mjs <shopify_domain> <orderId1,orderId2,...>
import fs from "node:fs";
import { execSync } from "node:child_process";

const [, , shop, idsArg] = process.argv;
if (!shop || !idsArg) { console.error("usage: node scripts/recover-reemit.mjs <shop> <id1,id2,...>"); process.exit(1); }
const orderIds = idsArg.split(",").map(s => s.trim()).filter(Boolean);

const env = fs.readFileSync("backoffice/.env.local", "utf8");
const getEnv = (k) => { const m = env.match(new RegExp("^" + k + "=(.*)$", "m")); return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : ""; };
const KEY = getEnv("ADMIN_API_KEY");
const WURL = getEnv("WORKER_URL").replace(/\/$/, "");
if (!KEY || !WURL) { console.error("missing ADMIN_API_KEY or WORKER_URL in backoffice/.env.local"); process.exit(1); }

// shop token + api version from prod D1
const sql = `SELECT shopify_token AS t, shopify_api_version AS v FROM integrations WHERE shopify_domain='${shop}'`;
const raw = execSync(`npx wrangler d1 execute rioko-db --remote --json --command "${sql}"`, { encoding: "utf8" });
const row = JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1))[0].results[0];
const token = row.t, ver = row.v || "2026-01";

for (const id of orderIds) {
  try {
    const oRes = await fetch(`https://${shop}/admin/api/${ver}/orders/${id}.json?fields=id,name,order_number`, { headers: { "X-Shopify-Access-Token": token } });
    const order = (await oRes.json()).order;
    if (!order) { console.log(`${id}: NOT FOUND in Shopify (${oRes.status})`); continue; }
    const r = await fetch(`${WURL}/admin/reemit-order`, {
      method: "POST",
      headers: { "x-api-key": KEY, "content-type": "application/json" },
      body: JSON.stringify({ shop, order_number: order.order_number, reason: "recovery: post country+self-heal fix", triggered_by: "claude-recovery" }),
    });
    const body = (await r.text()).slice(0, 300);
    console.log(`${order.name} (id ${id}, #${order.order_number}): http=${r.status} ${body}`);
  } catch (e) { console.log(`${id}: ERROR ${e.message}`); }
}
