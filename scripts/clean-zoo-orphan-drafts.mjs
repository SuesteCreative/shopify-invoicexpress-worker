#!/usr/bin/env node
/**
 * Delete the orphan DRAFT duplicates left on Zoo de Lagos by the 2026-09-01/02
 * backlog recovery.
 *
 * Where they came from: the recovery had to create ~200 documents while
 * `ix-proxy`'s reference lookup was taking 162s to answer "not found". Requests
 * were abandoned client-side after the document had already been created in
 * InvoiceXpress but before the local link was written, so the retry created a
 * second one. The retry's document is the one that got finalized; the first is
 * left behind as a draft carrying the same reference.
 *
 * A draft is not a fiscal document — no number, not reported to the AT, nobody
 * was invoiced twice. But it has to go, for two reasons: the reconciliation
 * sweep treats a draft with the right reference as "already invoiced" and stops
 * looking, and anyone who finalizes it later turns a harmless leftover into a
 * real duplicate.
 *
 * SAFETY: a draft is deleted only when EXACTLY ONE finalized document carries
 * the same reference. Two finalized documents on one reference is a real
 * duplicate and needs a credit note, not a delete — this script refuses to
 * touch those and prints them instead.
 *
 *   node scripts/clean-zoo-orphan-drafts.mjs --dry-run   # list, change nothing
 *   node scripts/clean-zoo-orphan-drafts.mjs             # delete
 */
import { execSync } from "node:child_process";

const DOMAIN = "zoolagos.myshopify.com";
const DRY = process.argv.includes("--dry-run");
// Far enough back to cover the whole blackout (26-29/08) and the recovery.
const STOP_BEFORE = "20260824";

const d1 = (sql) => {
  const out = execSync(
    `npx wrangler d1 execute rioko-db --remote --json --command "${sql}"`,
    { encoding: "utf8", maxBuffer: 64e6, stdio: ["ignore", "pipe", "ignore"] },
  );
  return JSON.parse(out.slice(out.search(/^\[/m)))[0].results;
};

const cfg = d1(
  `SELECT ix_account_name, ix_api_key, ix_environment FROM integrations WHERE shopify_domain='${DOMAIN}'`,
)[0];
if (!cfg) { console.error(`No integration for ${DOMAIN}`); process.exit(1); }

const base = `https://${cfg.ix_account_name}.app.invoicexpress.com`;
const proxyHeaders = {
  "x-account-name": cfg.ix_account_name,
  "x-api-key": cfg.ix_api_key,
  "x-env": cfg.ix_environment === "production" ? "prod" : "dev",
  "Content-Type": "application/json",
  Accept: "application/json",
};

// Listing straight from InvoiceXpress, NOT through ix-proxy: the proxy has no
// listing endpoint, and its per-reference lookup answers a miss in ~162s, which
// is what made every recovery path time out in the first place. This is ~460ms
// per page of 100.
const ymd = (s) => (s ? s.split("/").reverse().join("") : "");
const byReference = new Map();
let page = 1, totalPages = null, oldest = "";

while (page <= (totalPages ?? 60)) {
  const res = await fetch(
    `${base}/invoice_receipts.json?page=${page}&per_page=100&api_key=${cfg.ix_api_key}`,
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(60_000) },
  );
  if (!res.ok) { console.error(`page ${page}: HTTP ${res.status}`); break; }
  const body = await res.json();
  totalPages = body.pagination?.total_pages ?? totalPages;
  const list = body.invoice_receipts ?? [];
  if (!list.length) break;
  for (const doc of list) {
    const ref = String(doc.reference ?? "").trim();
    if (!ref) continue;
    if (!byReference.has(ref)) byReference.set(ref, []);
    byReference.get(ref).push({
      id: doc.id,
      status: String(doc.status ?? "").toLowerCase(),
      date: doc.date,
      total: doc.total,
    });
    oldest = doc.date ?? oldest;
  }
  if (ymd(oldest) < STOP_BEFORE) break;
  page++;
}

const targets = [];
for (const [ref, docs] of byReference) {
  const finalized = docs.filter((d) => d.status === "settled" || d.status === "final");
  const drafts = docs.filter((d) => d.status === "draft");
  if (!finalized.length || !drafts.length) continue;
  if (finalized.length > 1) {
    console.log(`!! ${ref}: ${finalized.length} FINALIZED documents (${finalized.map((d) => d.id).join(", ")}) — left alone, this needs a credit note`);
    continue;
  }
  for (const d of drafts) targets.push({ ref, id: d.id, keep: finalized[0].id, total: d.total });
}

console.log(`references read: ${byReference.size}`);
console.log(`orphan drafts to delete: ${targets.length}${DRY ? " (dry run)" : ""}`);
for (const t of targets) console.log(`   ${t.ref}: delete ${t.id}, keep ${t.keep} (${t.total} EUR)`);
if (DRY || !targets.length) process.exit(0);

let deleted = 0, failed = 0;
for (const t of targets) {
  try {
    const res = await fetch("https://ix-proxy.kapta.app/v2/change_state", {
      method: "POST",
      headers: proxyHeaders,
      body: JSON.stringify({ type: "invoice_receipt", id: Number(t.id), state: "deleted" }),
      signal: AbortSignal.timeout(120_000),
    });
    if (res.ok) { deleted++; console.log(`   deleted ${t.id} (${t.ref})`); }
    else { failed++; console.log(`   FAILED ${t.id} (${t.ref}): HTTP ${res.status} ${(await res.text()).slice(0, 90)}`); }
  } catch (e) {
    failed++;
    console.log(`   ERROR ${t.id} (${t.ref}): ${String(e.message).slice(0, 80)}`);
  }
}
console.log(`deleted=${deleted} failed=${failed}`);
process.exit(failed ? 1 : 0);
