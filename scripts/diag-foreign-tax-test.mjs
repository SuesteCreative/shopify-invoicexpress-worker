// CONTROLLED TEST (user-authorized): create a DRAFT invoice_receipt for a FOREIGN
// client forcing the IVA6 (6%) tax explicitly, observe whether IX honours 6% or
// forces Isento by EU rules, then DELETE/CANCEL the draft. Determines the forward
// fix for "bilheteira → 6% to all". Creates only a deletable draft; cleans up.
import { execSync } from "node:child_process";
const SHOP = "zoolagos.myshopify.com", PROXY = "https://ix-proxy.kapta.app";
const wq = (sql) => { const raw = execSync(`npx wrangler d1 execute rioko-db --remote --json --command "${sql}"`, { encoding: "utf8", maxBuffer: 64*1024*1024 }); return JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]")+1))[0].results; };
const cfg = wq(`SELECT ix_account_name AS acc, ix_api_key AS key, ix_environment AS env FROM integrations WHERE shopify_domain='${SHOP}'`)[0];
const ixH = { "x-account-name": cfg.acc, "x-api-key": cfg.key, "x-env": cfg.env === "production" ? "prod" : "dev", "Accept": "application/json", "Content-Type": "application/json" };

async function ix(method, path, body) {
  const r = await fetch(`${PROXY}${path}`, { method, headers: ixH, ...(body ? { body: JSON.stringify(body) } : {}) });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, j };
}

// Build a minimal draft invoice_receipt for a FRANCE client, forcing tax = IVA6
// (id 1072450, name IVA6, value 6) explicitly on the line.
const data = {
  client: { name: "TESTE FORWARD IVA6 — APAGAR", country: "France" },
  items: [{ name: "Teste entrada (apagar)", quantity: 1, unit_price: 10, tax: { id: 1072450, name: "IVA6", value: 6 } }],
  date: "2026-06-09",
  due_date: "2026-06-09",
};

(async () => {
  console.log("Creating DRAFT invoice_receipt for FRANCE client forcing IVA6 ...");
  const create = await ix("POST", "/v2/documents?resolvers=on_tax_fallback_search_tax_by_value", { data, type: "invoice_receipt" });
  console.log(`create status=${create.status}`);
  const id = create.j?.data?.id;
  if (!id) { console.log("NO ID. response:", JSON.stringify(create.j).slice(0, 500)); return; }
  console.log(`created id=${id} state=${create.j?.data?.status}`);

  // Inspect the tax IX actually assigned
  const doc = await ix("GET", `/v2/documents/${id}`);
  const items = doc.j?.data?.items || doc.j?.data?.lines || [];
  console.log("RESULT — tax IX assigned to the line(s):");
  for (const it of items) console.log("  ", JSON.stringify(it.tax ?? it.tax_name ?? it));
  console.log(`  client.country=${doc.j?.data?.client?.country}`);
  const verdict = items.every(it => { const v = typeof it.tax === "object" ? Number(it.tax?.value ?? 0) : Number(it.tax ?? 0); const nm = (typeof it.tax === "object" ? it.tax?.name : "") || ""; return v === 6 && !/isent/i.test(nm); });
  console.log(`\n>>> IX honoured IVA6 (6%) for a FOREIGN client? ${verdict ? "YES — forward fix viable (send explicit IVA6)" : "NO — IX forced Isento; need a different approach"}`);

  // Cleanup: cancel/delete the draft
  console.log("\nCleaning up (cancel/delete draft) ...");
  for (const state of ["deleted", "canceled"]) {
    const del = await ix("POST", "/v2/change_state", { type: "invoice_receipt", id, state });
    console.log(`  change_state ${state}: ${del.status} ${typeof del.j === "string" ? del.j.slice(0,80) : JSON.stringify(del.j).slice(0,120)}`);
    if (del.status >= 200 && del.status < 300) break;
  }
})();
