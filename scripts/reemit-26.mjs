// Re-emit the 26 genuinely-unbilled zoolagos PT-6% orders via the worker
// /admin/reemit-order (server-side: builds correctly, reconciles, records in DB,
// and now has the DOC010 client fallback). Gates on #1206 first: only proceeds
// to the rest if #1206 creates. Sequential + small delay to spare the IX proxy.
import fs from "node:fs";
const env = fs.readFileSync("backoffice/.env.local", "utf8");
const g = (k) => { const m = env.match(new RegExp("^" + k + "=(.*)$", "m")); return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : ""; };
const KEY = g("ADMIN_API_KEY"), W = g("WORKER_URL").replace(/\/$/, "");
const SHOP = "zoolagos.myshopify.com";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const ALL = [1037,1038,1039,1054,1056,1064,1066,1070,1072,1074,1090,1091,1098,1100,1102,1128,1133,1146,1149,1188,1189,1193,1206,1216,1218,1229];
const GATE = 1206;
const rest = ALL.filter(n => n !== GATE);

async function reemit(orderNumber) {
  const r = await fetch(`${W}/admin/reemit-order`, {
    method: "POST",
    headers: { "x-api-key": KEY, "content-type": "application/json" },
    body: JSON.stringify({ shop: SHOP, order_number: orderNumber, reason: "incident recovery: DOC010 client fallback", triggered_by: "claude-incident" }),
  });
  const j = await r.json().catch(() => ({}));
  const status = j.status ?? j.result?.status ?? `http${r.status}`;
  const message = j.message ?? j.result?.message ?? j.error ?? "";
  return { http: r.status, status, message };
}

const onlyGate = process.argv.includes("--gate-only");

(async () => {
  console.log(`Gate: re-emitting #${GATE} ...`);
  const g1 = await reemit(GATE);
  console.log(`  #${GATE}: ${g1.status} — ${g1.message}`);
  if (g1.status !== "created" && g1.status !== "skipped") {
    console.log(`\nGATE FAILED — not proceeding. Fix needed before bulk re-emit.`);
    process.exit(1);
  }
  if (onlyGate) { console.log("\n--gate-only: stopping after #1206 as requested."); return; }

  console.log(`\nGate OK. Re-emitting remaining ${rest.length} ...`);
  const results = [];
  for (const n of rest) {
    const res = await reemit(n);
    results.push({ n, ...res });
    console.log(`  #${n}: ${res.status} — ${res.message}`);
    await sleep(800); // gentle on the proxy
  }
  const created = results.filter(r => r.status === "created").length;
  const skipped = results.filter(r => r.status === "skipped").length;
  const failed = results.filter(r => r.status !== "created" && r.status !== "skipped");
  console.log(`\n=== SUMMARY (incl. gate) ===`);
  console.log(`created=${created + 1} skipped=${skipped} failed=${failed.length}`);
  if (failed.length) { console.log(`FAILED:`); for (const f of failed) console.log(`  #${f.n}: ${f.status} — ${f.message}`); }
})();
