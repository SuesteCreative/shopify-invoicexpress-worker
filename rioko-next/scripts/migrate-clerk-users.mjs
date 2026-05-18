// Migrate Clerk users from Development -> Production instance + emit D1 remap SQL.
//
// Usage (PowerShell):
//   $env:CLERK_DEV_SK="sk_test_..."
//   $env:CLERK_PROD_SK="sk_live_..."
//   node rioko-next/scripts/migrate-clerk-users.mjs           # dry-run (lists only)
//   node rioko-next/scripts/migrate-clerk-users.mjs --apply   # create in prod + emit files
//
// Outputs (when --apply):
//   scripts/out/clerk-mapping.csv  -> old_id,new_id,email
//   scripts/out/remap-d1.sql       -> UPDATE statements for D1 rioko-db

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "out");

const DEV = process.env.CLERK_DEV_SK;
const PROD = process.env.CLERK_PROD_SK;
const APPLY = process.argv.includes("--apply");

if (!DEV || !PROD) {
  console.error("Missing CLERK_DEV_SK or CLERK_PROD_SK env vars.");
  process.exit(1);
}
if (!DEV.startsWith("sk_test_")) console.warn("WARN: CLERK_DEV_SK does not start with sk_test_");
if (!PROD.startsWith("sk_live_")) console.warn("WARN: CLERK_PROD_SK does not start with sk_live_");

const API = "https://api.clerk.com/v1";

async function listUsers(sk) {
  const out = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const res = await fetch(`${API}/users?limit=${limit}&offset=${offset}&order_by=created_at`, {
      headers: { Authorization: `Bearer ${sk}` },
    });
    if (!res.ok) throw new Error(`List failed ${res.status}: ${await res.text()}`);
    const batch = await res.json();
    if (!batch.length) break;
    out.push(...batch);
    if (batch.length < limit) break;
    offset += batch.length;
  }
  return out;
}

async function createProdUser(u) {
  const emails = (u.email_addresses || []).map((e) => e.email_address).filter(Boolean);
  const body = {
    email_address: emails,
    first_name: u.first_name || undefined,
    last_name: u.last_name || undefined,
    username: u.username || undefined,
    public_metadata: u.public_metadata || {},
    private_metadata: u.private_metadata || {},
    unsafe_metadata: u.unsafe_metadata || {},
    external_id: u.external_id || undefined,
    skip_password_checks: true,
    skip_password_requirement: true,
    created_at: u.created_at ? new Date(u.created_at).toISOString() : undefined,
  };
  const res = await fetch(`${API}/users`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PROD}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  return JSON.parse(text);
}

function sqlEscape(s) {
  return String(s).replace(/'/g, "''");
}

(async () => {
  console.log(`Mode: ${APPLY ? "APPLY (writes Clerk Prod + emits files)" : "DRY-RUN"}`);
  console.log("Fetching Dev users...");
  const users = await listUsers(DEV);
  console.log(`Found ${users.length} dev users.\n`);

  const mapping = []; // { old_id, new_id, email }

  for (const u of users) {
    const email = u.email_addresses?.[0]?.email_address || "(no email)";
    const providers = (u.external_accounts || []).map((a) => a.provider).join(",") || "password";

    if (!APPLY) {
      console.log(`DRY  ${email}  [${providers}]  old_id=${u.id}`);
      continue;
    }
    try {
      const created = await createProdUser(u);
      console.log(`OK   ${email}  ${u.id} -> ${created.id}`);
      mapping.push({ old_id: u.id, new_id: created.id, email });
    } catch (e) {
      console.error(`FAIL ${email}: ${e.message}`);
    }
  }

  if (!APPLY) {
    console.log(`\n${users.length} users would be migrated. Re-run with --apply.`);
    return;
  }

  // Write mapping CSV
  mkdirSync(OUT_DIR, { recursive: true });
  const csvPath = resolve(OUT_DIR, "clerk-mapping.csv");
  const csv = ["old_id,new_id,email", ...mapping.map((m) => `${m.old_id},${m.new_id},${m.email}`)].join("\n");
  writeFileSync(csvPath, csv);
  console.log(`\nWrote ${csvPath}`);

  // Write D1 remap SQL (idempotent, integration FK first, then users row)
  const sqlPath = resolve(OUT_DIR, "remap-d1.sql");
  const lines = [
    "-- Clerk Dev -> Prod ID remap for D1 rioko-db",
    "-- Run with: npx wrangler d1 execute rioko-db --remote --file=rioko-next/scripts/out/remap-d1.sql",
    "",
  ];
  for (const { old_id, new_id, email } of mapping) {
    const o = sqlEscape(old_id);
    const n = sqlEscape(new_id);
    lines.push(`-- ${email}: ${old_id} -> ${new_id}`);
    // 1. Create new user row by copying old (preserves role, email, name)
    lines.push(`INSERT OR IGNORE INTO users (id, email, name, role, last_login) SELECT '${n}', email, name, role, last_login FROM users WHERE id = '${o}';`);
    // 2. If new row already existed (e.g. webhook fired), make sure role is preserved from old
    lines.push(`UPDATE users SET role = (SELECT role FROM users WHERE id = '${o}') WHERE id = '${n}' AND (role IS NULL OR role = 'user') AND EXISTS (SELECT 1 FROM users WHERE id = '${o}' AND role IS NOT NULL AND role != 'user');`);
    // 3. Reassign integrations FK
    lines.push(`UPDATE integrations SET user_id = '${n}' WHERE user_id = '${o}';`);
    // 4. Delete old user row
    lines.push(`DELETE FROM users WHERE id = '${o}';`);
    lines.push("");
  }
  writeFileSync(sqlPath, lines.join("\n"));
  console.log(`Wrote ${sqlPath}`);

  console.log(`\nNext steps:`);
  console.log(`  1. wrangler login   (if not yet authenticated)`);
  console.log(`  2. npx wrangler d1 execute rioko-db --remote --file=rioko-next/scripts/out/remap-d1.sql`);
  console.log(`  3. Verify in CF dashboard or via: npx wrangler d1 execute rioko-db --remote --command "SELECT id,email,role FROM users;"`);
})();
