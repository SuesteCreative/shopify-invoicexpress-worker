#!/usr/bin/env node
/**
 * READ-ONLY shadow run for the document-date fix.
 *
 * For every live Stripe connection, takes real paid charges and compares the
 * date the document carries TODAY (`charge.created`) with the date it would
 * carry after the fix (`invoice.status_transitions.paid_at`, when there is an
 * invoice). Reports, per connection, how many documents move and by how much.
 *
 * Credentials are read from D1 in-process and never printed.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const DAYS = Number(process.env.DAYS ?? 45);
const SINCE = Math.floor((Date.now() - DAYS * 864e5) / 1000);

const env = {};
for (const l of readFileSync("backoffice/.env.local", "utf8").split(/\r?\n/)) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim();
}
const wq = (sql) => JSON.parse(
  execSync(`npx wrangler d1 execute rioko-db --remote --json --command "${sql.replace(/"/g, '\\"')}"`,
    { encoding: "utf8", maxBuffer: 1e8, stdio: ["ignore", "pipe", "pipe"] }).match(/\[[\s\S]*\]/)[0],
)[0].results;

const conns = wq(`
  SELECT c.id, c.user_id, c.source_kind, c.destination_kind,
         COALESCE(u.admin_label, u.company_name, u.email) AS nome,
         json_extract(c.source_config_json,'$.stripe_account_id') AS acct,
         json_extract(c.source_config_json,'$.restricted_key')    AS rk
    FROM connections c LEFT JOIN users u ON u.id = c.user_id
   WHERE c.status = 'active' AND c.source_kind LIKE 'stripe%'`.replace(/\s+/g, " "));

console.error(`-- ${conns.length} ligações Stripe activas`);

const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);

for (const c of conns) {
  const key = c.rk || env.KAPTA_STRIPE_RK;
  const headers = { Authorization: `Bearer ${key}`, "Stripe-Version": "2024-12-18.acacia" };
  if (c.acct && !c.rk) headers["Stripe-Account"] = c.acct;

  const get = async (path, params = {}) => {
    const qs = new URLSearchParams({ ...params });
    const r = await fetch(`https://api.stripe.com/v1/${path}?${qs}`, { headers });
    return r.json();
  };

  let charges = [];
  try {
    let sa;
    for (let i = 0; i < 10; i++) {
      const p = { limit: "100", "created[gte]": String(SINCE), "expand[]": "data.invoice" };
      if (sa) p.starting_after = sa;
      const j = await get("charges", p);
      if (j.error) throw new Error(j.error.message ?? "erro");
      charges.push(...j.data);
      if (!j.has_more) break; sa = j.data[j.data.length - 1].id;
    }
  } catch (e) {
    console.log(`${String(c.nome).padEnd(28)} ${c.source_kind.padEnd(15)} — não foi possível ler (${String(e.message).slice(0, 50)})`);
    continue;
  }

  const paid = charges.filter((ch) => ch.status === "succeeded" && ch.paid);
  const moved = [];
  const methods = {};
  for (const ch of paid) {
    const m = ch.payment_method_details?.type ?? "?";
    methods[m] = (methods[m] ?? 0) + 1;
    const inv = ch.invoice && typeof ch.invoice === "object" ? ch.invoice : null;
    const paidAt = Number(inv?.status_transitions?.paid_at);
    if (!Number.isFinite(paidAt) || paidAt <= 0) continue;
    if (day(paidAt) !== day(ch.created)) {
      moved.push({ id: ch.id, m, de: day(ch.created), para: day(paidAt), dias: Math.round((paidAt - ch.created) / 86400) });
    }
  }
  const byMethod = moved.reduce((a, x) => ((a[x.m] = (a[x.m] ?? 0) + 1), a), {});
  console.log(
    `${String(c.nome).padEnd(28)} ${c.source_kind.padEnd(15)} ${String(paid.length).padStart(4)} pagos | `
    + `mudam de data: ${String(moved.length).padStart(3)}`
    + (moved.length ? `  ${JSON.stringify(byMethod)}  máx ${Math.max(...moved.map((x) => x.dias))}d` : "")
    + `  | métodos ${JSON.stringify(methods)}`,
  );
}
