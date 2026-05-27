#!/usr/bin/env node
// Pre-deploy D1 snapshot. Run as part of `npm run deploy:safe`.
// Writes backups/pre-<ISO>.sql; non-fatal if export fails (logs warning).

import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const ts = new Date().toISOString().replace(/[:.]/g, "-");
const file = `backups/pre-${ts}.sql`;

mkdirSync("backups", { recursive: true });

console.log(`[pre-deploy] D1 snapshot → ${file}`);
try {
    execSync(
        `npx --no-install wrangler d1 export rioko-db --remote --output ${file}`,
        { stdio: "inherit" },
    );
    console.log(`[pre-deploy] snapshot ok`);
} catch (e) {
    console.warn(`[pre-deploy] snapshot FAILED (deploy will proceed anyway):`, e?.message ?? e);
    process.exit(0); // non-fatal: don't block deploy on backup hiccup
}
