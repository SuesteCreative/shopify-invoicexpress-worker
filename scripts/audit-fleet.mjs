#!/usr/bin/env node
/**
 * Fleet-wide "was the money invoiced?" audit.
 *
 * Every incident we have chased this year had the same shape: something declined
 * to issue a document, recorded that as a success, and nobody found out until a
 * merchant counted their own invoices. Log-based checks cannot catch that class
 * by construction — the logs say it went fine.
 *
 * So this asks the only question that cannot lie, for every connection on every
 * platform: for each payment the source says was PAID, does a document actually
 * exist at the destination? It reuses /admin/reconciliation, which reads the
 * destination live, so it sees what the merchant sees.
 *
 *   node scripts/audit-fleet.mjs [--days 30] [--json out.json]
 *
 * Reads WORKER_URL + ADMIN_API_KEY from backoffice/.env.local.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const DAYS = Number(argOf("--days", "30"));
const JSON_OUT = argOf("--json", null);

// ── credentials ──────────────────────────────────────────────────────────────
const env = {};
for (const line of readFileSync("backoffice/.env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const WORKER_URL = env.WORKER_URL;
const ADMIN_API_KEY = env.ADMIN_API_KEY;
if (!WORKER_URL || !ADMIN_API_KEY) {
  console.error("Missing WORKER_URL / ADMIN_API_KEY in backoffice/.env.local");
  process.exit(1);
}

// ── inventory: every merchant, every platform ────────────────────────────────
// Connection-based merchants (Stripe/Lodgify/EuPago → Moloni/IX/Vendus) live in
// `connections`; the older Shopify→InvoiceXpress fleet lives in `integrations`.
// An audit that reads only one of them is how a whole platform goes unwatched.
// Read queries must use --command: `--file` uploads the SQL and reports only a
// summary ("Total queries executed", "Rows read"), so every column comes back
// undefined and the audit silently reports an empty fleet.
//
// Keep literals single-quoted — the command is wrapped in double quotes so the
// whole query survives cmd.exe, PowerShell and sh alike.
function d1(sql) {
  if (sql.includes('"')) throw new Error(`d1(): use single quotes in SQL literals — ${sql}`);
  const out = execSync(
    `npx wrangler d1 execute rioko-db --remote --json --command "${sql}"`,
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  );
  // wrangler prints a progress banner before the payload; the JSON array is the
  // first line that starts with "[".
  const at = out.search(/^\[/m);
  if (at < 0) throw new Error(`d1(): no JSON in wrangler output — ${out.slice(0, 200)}`);
  return JSON.parse(out.slice(at))[0].results;
}

const label = new Map(d1("SELECT id, COALESCE(admin_label,'') AS l FROM users").map(u => [u.id, u.l]));

const targets = [];
for (const c of d1(
  "SELECT user_id, source_kind, destination_kind, status FROM connections WHERE status = 'active'",
)) {
  targets.push({
    key: c.user_id,
    query: `user_id=${encodeURIComponent(c.user_id)}`,
    platform: `${c.source_kind} → ${c.destination_kind}`,
    name: label.get(c.user_id) || c.user_id,
  });
}
for (const i of d1(
  "SELECT user_id, shopify_domain FROM integrations WHERE is_paused = 0 AND shopify_authorized = 1 AND ix_authorized = 1 AND shopify_domain IS NOT NULL",
)) {
  targets.push({
    key: i.shopify_domain,
    query: `shop=${encodeURIComponent(i.shopify_domain)}`,
    platform: "shopify → invoicexpress",
    name: label.get(i.user_id) || i.shopify_domain,
  });
}

// ── the check ────────────────────────────────────────────────────────────────
// `to` is TOMORROW, not today. The window is a date string and each source
// applies it differently — Stripe turns it into a `created<=` unix timestamp at
// 00:00, so asking for "…to=today" silently drops everything that happened today
// and the audit reports a clean day while a payment sits unbilled. That is how
// MY VAN's 14/08 payment went missing from the first run of this script.
const to = new Date(Date.now() + 864e5);
const from = new Date(Date.now() - DAYS * 864e5);
const iso = d => d.toISOString().slice(0, 10);

const money = n => `${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} €`;
const rows = [];

console.log(`Auditoria de ${targets.length} merchants · janela ${iso(from)} → ${iso(to)}\n`);

for (const t of targets) {
  const url = `${WORKER_URL}/admin/reconciliation?${t.query}&from=${iso(from)}&to=${iso(to)}`;
  let data;
  try {
    const res = await fetch(url, { headers: { "x-api-key": ADMIN_API_KEY } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
    data = await res.json();
  } catch (e) {
    rows.push({ ...t, error: String(e.message ?? e) });
    console.log(`  ✗  ${t.name} · ${t.platform} — ${String(e.message ?? e).slice(0, 90)}`);
    continue;
  }

  // "Unbilled" is deliberately narrow, because an audit that cries wolf gets
  // ignored and then the real miss hides inside the noise. A sale counts only if
  // it is PAID, has no document, and nobody had a reason not to invoice it:
  //
  //   pre_cutoff  the sale predates the integration — the merchant's previous
  //               process billed it, and issuing it now would DUPLICATE
  //   not_needed  an operator deliberately excluded it
  //   total 0     PT rules don't require a document and destinations reject it
  //   cancelled   nothing to invoice
  //
  // Counted and reported separately rather than dropped, so nothing is hidden.
  const paidRows = (data.rows ?? []).filter(
    r => r.match?.type === "none" && r.order?.financial_status === "paid" && r.order?.refund_state !== "cancelled",
  );
  const preCutoff = paidRows.filter(r => r.pre_cutoff);
  const zeroTotal = paidRows.filter(r => !r.pre_cutoff && !(Number(r.order?.total ?? 0) > 0));
  const unbilled = paidRows.filter(r => !r.pre_cutoff && Number(r.order?.total ?? 0) > 0);
  const amount = unbilled.reduce((s, r) => s + Number(r.order?.total ?? 0), 0);

  // Shared-reference detector: the defect behind the 2026-08-13 incident. If two
  // sales carry the SAME document reference, the destination's idempotency check
  // will discard every later payment as a duplicate of the first.
  const refs = new Map();
  for (const r of data.rows ?? []) {
    const ref = r.invoice?.reference;
    if (!ref) continue;
    refs.set(ref, (refs.get(ref) ?? 0) + 1);
  }
  const collisions = [...refs.entries()].filter(([, n]) => n > 1);

  // Draft vs finalized. A draft is NOT a fiscal document — it carries no number,
  // it is not communicated to the AT, and the merchant cannot give it to a buyer.
  // Reconciliation counts one as "invoiced" (correctly: it exists, and re-issuing
  // would duplicate), so a shop left on auto_finalize=0 reads as fully invoiced
  // while owning nothing it can legally hand over. Worth seeing explicitly.
  const issued = (data.rows ?? []).filter(r => r.invoice);
  const drafts = issued.filter(r => String(r.invoice?.status ?? "").toLowerCase() === "draft");

  const row = {
    ...t,
    total: data.total_orders ?? 0,
    unbilled: unbilled.length,
    amount,
    pre_cutoff: preCutoff.length,
    zero_total: zeroTotal.length,
    issued: issued.length,
    drafts: drafts.length,
    collisions: collisions.map(([ref, n]) => `${ref} ×${n}`),
    ids: unbilled.map(r => ({ id: r.order?.id, date: r.order?.paid_at?.slice(0, 10), total: r.order?.total })),
  };
  rows.push(row);

  const flag = row.unbilled > 0 ? "⚠ " : collisions.length ? "◆ " : "  ";
  const detail = [
    `${row.total} vendas`,
    row.unbilled ? `${row.unbilled} SEM FATURA (${money(amount)})` : "tudo faturado",
    preCutoff.length ? `${preCutoff.length} anteriores à integração` : "",
    zeroTotal.length ? `${zeroTotal.length} a 0 €` : "",
    drafts.length ? `${drafts.length}/${issued.length} SÓ RASCUNHO` : "",
    collisions.length ? `REFERÊNCIA PARTILHADA: ${collisions.map(([r, n]) => `${r} ×${n}`).join(", ")}` : "",
  ].filter(Boolean).join(" · ");
  console.log(`${flag}${t.name} · ${t.platform} — ${detail}`);
}

// ── summary ──────────────────────────────────────────────────────────────────
const bad = rows.filter(r => r.unbilled > 0);
const collided = rows.filter(r => r.collisions?.length);
const failed = rows.filter(r => r.error);
const totalMoney = bad.reduce((s, r) => s + r.amount, 0);

console.log(`\n${"─".repeat(72)}`);
console.log(`Merchants auditados : ${rows.length - failed.length}/${rows.length}`);
console.log(`Com faturas em falta: ${bad.length}`);
console.log(`Valor por faturar   : ${money(totalMoney)}`);
console.log(`Referência partilhada (risco de dedup): ${collided.length}`);
if (failed.length) console.log(`Não auditados (erro): ${failed.map(f => f.name).join(", ")}`);

if (bad.length) {
  console.log(`\nDetalhe:`);
  for (const r of bad.sort((a, b) => b.amount - a.amount)) {
    console.log(`\n  ${r.name} · ${r.platform} — ${r.unbilled} × ${money(r.amount)}`);
    for (const o of r.ids) console.log(`    ${o.id}  ${o.date}  ${money(Number(o.total))}`);
  }
}

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({ window: { from: iso(from), to: iso(to) }, rows }, null, 2));
  console.log(`\nJSON → ${JSON_OUT}`);
}

process.exit(bad.length || failed.length ? 1 : 0);
