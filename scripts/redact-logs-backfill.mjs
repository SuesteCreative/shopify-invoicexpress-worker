#!/usr/bin/env node
/**
 * One-off: redact credentials already sitting in the `logs` table.
 *
 * PR #32 puts redactDeep() on the INSERT, which stops NEW rows. It does nothing
 * about the ones already stored — 224 of them on 2026-09-12, the oldest from
 * March, holding a merchant's InvoiceXpress key in plain text because IX takes
 * its credential in the query string and the log quotes the request verbatim.
 * `logs` has no retention sweep, so those rows never age out on their own.
 *
 * Reuses the SAME redactSecrets() the write path uses (bundled via
 * `npm run gen:redact`), so the backfill cannot drift from the live behaviour —
 * a second implementation in SQL would, and SQLite has no regex anyway.
 *
 *   node scripts/redact-logs-backfill.mjs           # dry run, counts only
 *   node scripts/redact-logs-backfill.mjs --apply   # writes
 *
 * Prints counts and row ids only. It never prints payload or response content:
 * the whole point is that those strings hold credentials.
 */
import { execSync } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "./.gen/redact.mjs";

const APPLY = process.argv.includes("--apply");
const DB = "rioko-db";
const MATCH = "payload LIKE '%api_key=%' OR response LIKE '%api_key=%'";

// A shell command string, like every other script here (audit-shopify,
// audit-fleet). NOT execFileSync: Node 22 on Windows refuses to spawn npx.cmd
// without a shell, and turning the shell on instead re-splits the SQL on spaces
// so wrangler sees thirty unknown arguments rather than one --command.
const d1 = (tail) =>
    execSync(`npx wrangler d1 execute ${DB} --remote --json ${tail}`, {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
    });

const query = (sql) => JSON.parse(d1(`--command "${sql.replaceAll('"', '\\"')}"`))[0].results;
const sqlStr = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replaceAll("'", "''")}'`);

if (!existsSync(new URL("./.gen/redact.mjs", import.meta.url))) {
    console.error("Falta scripts/.gen/redact.mjs — corre `npm run gen:redact` primeiro.");
    process.exit(1);
}

const rows = query(`SELECT id, payload, response FROM logs WHERE ${MATCH}`);
console.log(`linhas com credencial: ${rows.length}`);

const updates = [];
for (const r of rows) {
    const payload = r.payload == null ? r.payload : redactSecrets(String(r.payload));
    const response = r.response == null ? r.response : redactSecrets(String(r.response));
    if (payload !== r.payload || response !== r.response) {
        updates.push({ id: r.id, payload, response });
    }
}

// Most matching rows are ALREADY redacted — they hold the literal
// "api_key=«redacted»", put there upstream before the string ever reached the
// log. Those are fine and must not be reported as a problem; on 2026-09-12 they
// were 221 of 224, and counting them as "not altered" made a solved problem
// look like an open one.
//
// What matters is the third category: a row that still carries a key in the
// clear AND that redactSecrets does not change. That is a genuine gap between
// the pattern and the data, and the backfill would skip it in silence.
const changed = new Set(updates.map(u => u.id));
const hasPlainKey = (r) =>
    /[?&"']?api[-_]?key["']?\s*[:=]\s*(?!«redacted»)/i.test(`${r.payload ?? ""}${r.response ?? ""}`);
const gaps = rows.filter(r => !changed.has(r.id) && hasPlainKey(r));

console.log(`ja redigidas a montante: ${rows.length - updates.length - gaps.length}`);
console.log(`a reescrever: ${updates.length}`);
if (gaps.length > 0) {
    console.log(`GAP — em claro e nao cobertas pelo padrao: ${gaps.length}`);
    console.log(`  ids: ${gaps.slice(0, 20).map(r => r.id).join(", ")}${gaps.length > 20 ? ` (+${gaps.length - 20})` : ""}`);
}

// Belt and braces: the redacted text must no longer contain a key. Checked on
// the output, not assumed from the patterns.
const stillDirty = updates.filter(u => /[?&]api_key=(?!«redacted»)/i.test(`${u.payload ?? ""}${u.response ?? ""}`));
if (stillDirty.length) {
    console.error(`ABORTADO: ${stillDirty.length} linhas continuariam com credencial depois de redigir.`);
    process.exit(1);
}

if (!APPLY) {
    console.log("\n(dry run — nada foi escrito. Repetir com --apply)");
    process.exit(0);
}

const file = new URL("./.gen/redact-logs-backfill.sql", import.meta.url);
const sql = updates
    .map(u => `UPDATE logs SET payload = ${sqlStr(u.payload)}, response = ${sqlStr(u.response)} WHERE id = ${sqlStr(u.id)};`)
    .join("\n");
writeFileSync(file, sql + "\n", "utf8");

d1(`--file "${fileURLToPath(file)}"`);
const left = query(`SELECT COUNT(*) AS n FROM logs WHERE ${MATCH} AND (payload LIKE '%api_key=%' AND payload NOT LIKE '%api_key=«redacted»%' OR response LIKE '%api_key=%' AND response NOT LIKE '%api_key=«redacted»%')`);
console.log(`escrito. linhas ainda com credencial por redigir: ${left[0].n}`);
