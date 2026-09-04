#!/usr/bin/env node
/**
 * Bring every Stripe connection's webhook endpoint up to date with the events
 * the worker knows how to handle.
 *
 * An endpoint is created once, at install, with the event list of that day. When
 * a new event joins the list — `invoice.paid`, so that money a merchant marks as
 * paid OUTSIDE Stripe is invoiced at all — every endpoint installed before that
 * day keeps not receiving it. Nothing reports this: the events fire, Stripe has
 * nobody to deliver them to (`pending_webhooks: 0`), and the merchant simply
 * never sees those documents.
 *
 *   node scripts/stripe-sync-webhook-events.mjs            # dry run
 *   node scripts/stripe-sync-webhook-events.mjs --apply
 *   node scripts/stripe-sync-webhook-events.mjs --apply --status active,draft
 *
 * Adds only. An event someone put on an endpoint by hand is not ours to remove.
 * Restricted keys are read into memory and never printed.
 */
import { execSync } from "node:child_process";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const STATUSES = argOf("--status", "active").split(",").map(s => s.trim()).filter(Boolean);

// Mirrors ENABLED_EVENTS in
// backoffice/src/app/api/integrations/stripe-source/install-webhook/route.ts.
// If you add an event there, add it here and run this.
const ENABLED_EVENTS = [
  "payment_intent.succeeded",
  "charge.succeeded",
  "charge.refunded",
  "checkout.session.completed",
  "invoice.paid",
];

function d1(sql) {
  const raw = execSync(`npx wrangler d1 execute rioko-db --remote --json --command "${sql}"`, {
    encoding: "utf8", maxBuffer: 32 << 20, stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1))[0].results ?? [];
}

const inList = STATUSES.map(s => `'${s.replace(/'/g, "")}'`).join(",");
const rows = d1(
  `SELECT c.user_id, c.status, c.destination_kind, coalesce(u.admin_label, u.name, c.user_id) AS label,`
  + ` json_extract(c.source_config_json,'$.restricted_key') AS k,`
  + ` json_extract(c.source_config_json,'$.webhook_endpoint_id') AS endpoint`
  + ` FROM connections c LEFT JOIN users u ON u.id = c.user_id`
  + ` WHERE c.source_kind = 'stripe' AND c.status IN (${inList}) ORDER BY label`,
);

console.log(`${rows.length} Stripe connections with status in ${STATUSES.join("/")}\n`);

let changed = 0, alreadyOk = 0, skipped = 0, failed = 0;

for (const row of rows) {
  const who = `${row.label} (${row.destination_kind}, ${row.status})`;

  if (!row.k || !row.endpoint) {
    // No key means we cannot ask Stripe anything; no endpoint id means the
    // install never completed, or the endpoint was created by hand outside the
    // console and we do not know which one it is.
    console.log(`  ⊘ ${who}: ${!row.k ? "no restricted_key" : "no webhook_endpoint_id"} — nothing to sync`);
    skipped++;
    continue;
  }

  const call = async (method, body) => {
    const res = await fetch(`https://api.stripe.com/v1/webhook_endpoints/${encodeURIComponent(row.endpoint)}`, {
      method,
      headers: {
        Authorization: `Bearer ${row.k}`,
        "Stripe-Version": "2024-12-18.acacia",
        ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(body ? { body } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const before = await call("GET");
  if (before.status !== 200) {
    console.log(`  ✗ ${who}: Stripe ${before.status} reading ${row.endpoint} — ${before.body?.error?.message ?? ""}`);
    failed++;
    continue;
  }

  const have = before.body.enabled_events ?? [];
  const missing = ENABLED_EVENTS.filter(e => !have.includes(e));
  if (!missing.length) {
    console.log(`  ✓ ${who}: already complete (${before.body.status})`);
    alreadyOk++;
    continue;
  }

  if (!APPLY) {
    console.log(`  → ${who}: would add ${missing.join(", ")}  [${before.body.status}]`);
    changed++;
    continue;
  }

  const union = [...new Set([...have, ...ENABLED_EVENTS])];
  const form = new URLSearchParams();
  union.forEach((e, i) => form.set(`enabled_events[${i}]`, e));
  const after = await call("POST", form.toString());
  if (after.status !== 200) {
    console.log(`  ✗ ${who}: Stripe ${after.status} updating — ${after.body?.error?.message ?? ""}`);
    failed++;
    continue;
  }
  console.log(`  ✓ ${who}: added ${missing.join(", ")}`);
  changed++;
}

console.log(`\n${APPLY ? "updated" : "would update"} ${changed}, already complete ${alreadyOk}, skipped ${skipped}, failed ${failed}`);
if (!APPLY && changed) console.log("Dry run. Re-run with --apply.");
