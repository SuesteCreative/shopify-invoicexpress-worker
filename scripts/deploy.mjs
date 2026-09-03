#!/usr/bin/env node
/**
 * The deploy, with the three things that keep going wrong done for you.
 *
 *   npm run deploy            [-- extra wrangler args]
 *   npm run deploy -- --dry-run
 *
 * 1. STAMPS THE COMMIT. Cloudflare records a version id and a wall clock, and
 *    neither says which code is serving traffic. On 2026-08-17 the only way to
 *    answer "is the M99 fix live?" was to line `git log` (Lisbon) up against
 *    `wrangler deployments list` (UTC) and infer. So the commit, branch, dirty
 *    flag and deploy time go up as vars and come back out of /admin/version.
 *
 * 2. CHECKS THE SECRETS SURVIVED. `wrangler deploy` from a machine whose
 *    wrangler config does not carry them has silently dropped this worker's
 *    secrets before. They are listed before and after, and anything that
 *    disappeared is named — loudly, with the command to put it back.
 *
 * 3. REFUSES QUIETLY DANGEROUS DEPLOYS. A dirty tree cannot be reproduced from
 *    its commit, and a deploy from a feature branch puts unreviewed code in
 *    front of every merchant. Both are allowed with --force, never by accident.
 *
 * Reads WORKER_URL + ADMIN_API_KEY from backoffice/.env.local, when present,
 * to read the deployed version back and confirm it is the commit we just sent.
 */
import { execSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const argv = process.argv.slice(2);
const force = argv.includes("--force");
const passthrough = argv.filter((a) => a !== "--force");

const sh = (cmd) => execSync(cmd, { encoding: "utf8" }).trim();
const say = (m) => console.log(`[deploy] ${m}`);
const warn = (m) => console.warn(`[deploy] ⚠  ${m}`);

// ── what we are about to ship ────────────────────────────────────────────────
// Two ways to know, because this script now has two callers.
//
// Workers Builds checks out DETACHED, so `git rev-parse --abbrev-ref HEAD`
// there answers "HEAD" — and the not-main guard below would then refuse every
// single production build. That is how "just set the deploy command to
// `npm run deploy`" turns into a worker that silently never ships again. When
// the platform tells us where we are, believe the platform.
let sha, branch, dirty;
const onWorkersCI = process.env.WORKERS_CI === "1";

if (onWorkersCI) {
  sha = process.env.WORKERS_CI_COMMIT_SHA ?? "";
  branch = process.env.WORKERS_CI_BRANCH ?? "";
  // A CI build is a clean checkout of exactly one commit: there is nothing
  // uncommitted to warn about, and there may be no git dir to ask.
  dirty = false;
  if (!sha || !branch) {
    console.error("[deploy] WORKERS_CI is set but WORKERS_CI_COMMIT_SHA/BRANCH are not — refusing to ship something I cannot name");
    process.exit(1);
  }
} else {
  try {
    sha = sh("git rev-parse HEAD");
    branch = sh("git rev-parse --abbrev-ref HEAD");
    // Only source that ships matters. backoffice/, scripts/ and docs ride along
    // in the repo but are not in the worker bundle, so they do not make a deploy
    // irreproducible and must not block one.
    dirty = sh("git status --porcelain -- src wrangler.jsonc package.json").length > 0;
  } catch {
    console.error("[deploy] not a git checkout — refusing to deploy something I cannot name");
    process.exit(1);
  }
}

say(`${branch} @ ${sha.slice(0, 7)}${dirty ? " (ÁRVORE SUJA)" : ""}${onWorkersCI ? " [Workers Builds]" : ""}`);

const objections = [];
if (dirty) objections.push("the worker source has uncommitted changes — this deploy is not reproducible from its commit");
if (branch !== "main") objections.push(`deploying from '${branch}', not main — production would run unreviewed code`);
if (objections.length && !force) {
  for (const o of objections) warn(o);
  console.error(`[deploy] refusing. Commit and merge first, or re-run with --force if that is genuinely what you want.`);
  process.exit(1);
}
for (const o of objections) warn(`${o} (forçado)`);

// ── secrets, before ──────────────────────────────────────────────────────────
const secretNames = () => {
  try {
    return JSON.parse(sh("npx --no-install wrangler secret list")).map((s) => s.name).sort();
  } catch (e) {
    warn(`could not list secrets: ${e?.message ?? e}`);
    return null;
  }
};
const before = secretNames();
if (before) say(`secrets antes: ${before.join(", ")}`);

// ── the deploy itself ────────────────────────────────────────────────────────
const builtAt = new Date().toISOString();
const args = [
  "--no-install", "wrangler", "deploy",
  "--var", `GIT_SHA:${sha}`,
  "--var", `GIT_BRANCH:${branch}`,
  "--var", `GIT_DIRTY:${dirty ? "1" : "0"}`,
  "--var", `BUILT_AT:${builtAt}`,
  ...passthrough,
];
const run = spawnSync("npx", args, { stdio: "inherit", shell: process.platform === "win32" });
if (run.status !== 0) {
  console.error(`[deploy] wrangler exited ${run.status} — stopping here`);
  process.exit(run.status ?? 1);
}

if (passthrough.includes("--dry-run")) {
  say("dry-run: nada foi publicado");
  process.exit(0);
}

// ── secrets, after ───────────────────────────────────────────────────────────
const after = secretNames();
if (before && after) {
  const lost = before.filter((n) => !after.includes(n));
  if (lost.length) {
    warn(`O DEPLOY APAGOU ${lost.length} SECRET(S): ${lost.join(", ")}`);
    for (const n of lost) console.warn(`[deploy]     npx wrangler secret put ${n}`);
    process.exitCode = 1;
  } else {
    say(`secrets intactos (${after.length})`);
  }
}

// ── read back what is actually running ───────────────────────────────────────
const envFile = "backoffice/.env.local";
if (existsSync(envFile)) {
  const env = {};
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  if (env.WORKER_URL && env.ADMIN_API_KEY) {
    try {
      const res = await fetch(`${env.WORKER_URL}/admin/version`, { headers: { "x-api-key": env.ADMIN_API_KEY } });
      const v = await res.json();
      if (v.commit === sha) {
        say(`confirmado em produção: ${v.commit_short} (${v.branch})`);
      } else {
        // Cloudflare can serve the previous version for a few seconds; a
        // mismatch that persists means the deploy did not take.
        warn(`/admin/version diz ${v.commit_short ?? "unknown"}, esperava ${sha.slice(0, 7)} — reconfirmar daqui a instantes`);
        // Never fail a CI build over this: Cloudflare can serve the previous
        // version for a few seconds, and a red build would be read as "the
        // deploy failed" when the deploy is fine.
        if (!onWorkersCI) process.exitCode = 1;
      }
    } catch (e) {
      warn(`não consegui ler /admin/version: ${e?.message ?? e}`);
    }
  }
}
