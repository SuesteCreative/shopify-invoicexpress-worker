#!/usr/bin/env node
/**
 * Provision a Lodgify → Moloni connection, in the order that cannot bill a
 * merchant's back-catalogue by accident.
 *
 *   node scripts/onboard-lodgify-moloni.mjs <config.json> [--apply]
 *
 * The wizard (backoffice/src/app/api/integrations/lodgify-source/route.ts)
 * inserts the connection as `status='active'` and never writes
 * `invoice_cutoff`; the Worker reads a NULL cutoff as "invoice everything".
 * A merchant with years of paid history therefore gets all of it billed, dated
 * today, by the first unattended run. Nothing else stamps that column either —
 * the Stripe webhook only does it for rows in `status='paused'`.
 *
 * So this writes the connection as `draft`, stamps the cutoff, and only then
 * activates. Same config shape the wizard writes — if you change one, change
 * both.
 *
 * Config file (keep it OUT of the repo — it holds credentials):
 * {
 *   "email": "cliente@exemplo.pt",
 *   "lodgify_api_key": "...",
 *   "moloni_client_id": "...", "moloni_client_secret": "...",
 *   "moloni_username": "...", "moloni_password": "...",
 *   "moloni_company_name": "EMPRESA LDA",        // or moloni_company_id
 *   "moloni_document_set_name": "RVFR",          // optional: omit = account default série
 *   "moloni_document_type": "invoice_receipt",   // or "invoice"
 *   "auto_finalize": false,
 *   "invoice_cutoff": "2026-08-14T00:00:00.000Z" // optional, defaults to now
 * }
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [, , configPath, ...flags] = process.argv;
if (!configPath) {
  console.error("usage: node scripts/onboard-lodgify-moloni.mjs <config.json> [--apply]");
  process.exit(1);
}
const APPLY = flags.includes("--apply");
const cfg = JSON.parse(readFileSync(configPath, "utf8"));

const required = ["email", "lodgify_api_key", "moloni_client_id", "moloni_client_secret", "moloni_username", "moloni_password"];
for (const f of required) if (!cfg[f]) throw new Error(`config: missing ${f}`);
if (!cfg.moloni_company_id && !cfg.moloni_company_name) throw new Error("config: need moloni_company_id or moloni_company_name");

/** Run SQL against prod D1. Statements with credentials go via a temp file, never argv. */
function d1(sql, { viaFile = false } = {}) {
  if (viaFile) {
    const f = join(tmpdir(), `rioko-onboard-${randomUUID()}.sql`);
    writeFileSync(f, sql);
    try {
      return execSync(`npx wrangler d1 execute rioko-db --remote --json --file "${f}"`, { encoding: "utf8", maxBuffer: 32 << 20 });
    } finally {
      unlinkSync(f);
    }
  }
  return execSync(`npx wrangler d1 execute rioko-db --remote --json --command "${sql.replace(/"/g, '\\"')}"`, {
    encoding: "utf8", maxBuffer: 32 << 20,
  });
}
const rowsOf = (raw) => JSON.parse(raw.slice(raw.indexOf("[")))[0].results;
const q = (s) => String(s).replace(/'/g, "''");

// 1. Who is this, and is the subscription actually going to let them invoice?
const users = rowsOf(d1(`SELECT id, email, role, admin_label FROM users WHERE lower(email) = lower('${q(cfg.email)}')`));
if (users.length !== 1) throw new Error(`expected exactly 1 user for ${cfg.email}, found ${users.length}`);
const user = users[0];

const subs = rowsOf(d1(`SELECT status, stripe_subscription_id, early_bird, trial_end FROM subscriptions WHERE user_id = '${q(user.id)}'`));
const sub = subs[0] ?? null;
const gateOpen = !!sub && !["canceled", "unpaid", "incomplete_expired", "incomplete", "past_due"].includes(sub.status)
  && !(sub.status === "trialing" && !sub.stripe_subscription_id && !(sub.early_bird && sub.trial_end && new Date(sub.trial_end) > new Date()));

console.log(`user      : ${user.id} (${user.email}${user.admin_label ? `, ${user.admin_label}` : ""})`);
console.log(`subscript.: ${sub ? `${sub.status}${sub.stripe_subscription_id ? " + stripe sub" : " (no stripe sub)"}` : "NONE"} → gate ${gateOpen ? "OPEN" : "BLOCKED"}`);

const existing = rowsOf(d1(`SELECT id, status, invoice_cutoff FROM connections WHERE user_id = '${q(user.id)}' AND source_kind = 'lodgify'`));
console.log(`existing  : ${existing.length ? JSON.stringify(existing[0]) : "none"}`);

// 2. The two config blobs, in exactly the shape the wizard writes.
const sourceCfg = { api_key: cfg.lodgify_api_key };
const destCfg = {
  moloni_client_id: String(cfg.moloni_client_id),
  moloni_client_secret: String(cfg.moloni_client_secret),
  moloni_username: String(cfg.moloni_username),
  moloni_password: String(cfg.moloni_password),
  ...(cfg.moloni_company_id ? { moloni_company_id: Number(cfg.moloni_company_id) } : {}),
  ...(cfg.moloni_company_name ? { moloni_company_name: String(cfg.moloni_company_name) } : {}),
  ...(cfg.moloni_document_set_id ? { moloni_document_set_id: Number(cfg.moloni_document_set_id) } : {}),
  ...(cfg.moloni_document_set_name ? { moloni_document_set_name: String(cfg.moloni_document_set_name) } : {}),
  moloni_document_type: cfg.moloni_document_type === "invoice" ? "invoice" : "invoice_receipt",
  moloni_environment: cfg.moloni_environment === "sandbox" ? "sandbox" : "production",
  vat_included: cfg.vat_included !== false,
  auto_finalize: cfg.auto_finalize === true,
  send_email: cfg.send_email === true,
  // Off for a new tenant: it changes billing from "one document at 100% paid"
  // to "one per newly-paid delta", and the transition guard only protects
  // bookings the standard flow already billed. Turn it on later, deliberately.
  moloni_partial_invoicing: cfg.moloni_partial_invoicing === true,
  exemption_reason: cfg.exemption_reason ?? "M01",
};

const cutoff = cfg.invoice_cutoff ?? new Date().toISOString();
const id = existing[0]?.id ?? randomUUID();
const now = new Date().toISOString();

console.log(`cutoff    : ${cutoff}  ← nothing created before this is ever billed automatically`);
console.log(`document  : ${destCfg.moloni_document_type}, auto_finalize=${destCfg.auto_finalize}, partial=${destCfg.moloni_partial_invoicing}`);
console.log(`company   : ${destCfg.moloni_company_name ?? destCfg.moloni_company_id}  série: ${destCfg.moloni_document_set_name ?? destCfg.moloni_document_set_id ?? "(default)"}`);

if (!APPLY) {
  console.log("\nDRY RUN — nothing written. Re-run with --apply.");
  process.exit(0);
}
if (!gateOpen) throw new Error("subscription gate is BLOCKED — fix the subscription before activating, or the connection invoices nothing");

// 3. Write as draft WITH the cutoff, then activate. Never the other way round:
//    the window between an active connection and a stamped cutoff is exactly
//    when an unattended run bills the whole history.
d1(
  `INSERT INTO connections
     (id, user_id, source_kind, destination_kind, source_config_json, destination_config_json, status, invoice_cutoff, created_at, updated_at)
   VALUES ('${id}', '${q(user.id)}', 'lodgify', 'moloni', '${q(JSON.stringify(sourceCfg))}', '${q(JSON.stringify(destCfg))}', 'draft', '${q(cutoff)}', '${now}', '${now}')
   ON CONFLICT(user_id, source_kind, destination_kind) DO UPDATE SET
     source_config_json = excluded.source_config_json,
     destination_config_json = excluded.destination_config_json,
     status = 'draft',
     invoice_cutoff = excluded.invoice_cutoff,
     updated_at = excluded.updated_at;`,
  { viaFile: true },
);

const check = rowsOf(d1(`SELECT status, invoice_cutoff FROM connections WHERE user_id = '${q(user.id)}' AND source_kind = 'lodgify'`))[0];
if (!check?.invoice_cutoff) throw new Error("refusing to activate: invoice_cutoff did not stick");

d1(`UPDATE connections SET status = 'active', updated_at = '${now}' WHERE user_id = '${q(user.id)}' AND source_kind = 'lodgify'`);
console.log(`\nactivated : cutoff ${check.invoice_cutoff} verified before flipping to active`);
console.log("next      : GET /admin/lodgify/feed-manifest (expect has_cutoff=true), then a dry feeder run");
