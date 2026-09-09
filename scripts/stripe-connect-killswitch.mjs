#!/usr/bin/env node
/**
 * The emergency brake for the Stripe Connect → Moloni integration.
 *
 * WHY IT EXISTS: the new integration shares code with the Stripe → Moloni
 * connections that are already invoicing real customers. Every new code path is
 * gated on a flag that no existing connection sets, and the test suite pins
 * that — but "the tests say so" is not a thing to lean on at 9am on a Monday
 * with a merchant on the phone. This gives a way to stop the new integration in
 * seconds, WITHOUT a deploy, and a way to answer "is the old one still fine?"
 * without opening five dashboards.
 *
 * READ-ONLY — safe to run any time, by anyone, including an agent:
 *   node scripts/stripe-connect-killswitch.mjs            # state of both integrations
 *   node scripts/stripe-connect-killswitch.mjs --check    # is the EXISTING integration healthy?
 *   node scripts/stripe-connect-killswitch.mjs --baseline  # snapshot BEFORE deploying
 *   node scripts/stripe-connect-killswitch.mjs --rollback # print the rollback runbook
 *   ... --off --dry-run / --on --dry-run                  # what would change, changing nothing
 *
 * CHANGES PRODUCTION — refuses to run without a real terminal and a typed phrase:
 *   node scripts/stripe-connect-killswitch.mjs --off      # pause every stripe_connect connection
 *   node scripts/stripe-connect-killswitch.mjs --on       # undo --off
 *
 * `--off` touches ONLY rows whose source_kind is 'stripe_connect'. By
 * definition those are connections created by the new wizard: no existing
 * customer has one, and the statement cannot match their rows even if it ran
 * twice. It does not deploy, does not restart anything, and takes effect on the
 * next event because the worker filters on `status = 'active'`.
 */
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);

/**
 * Nothing here changes state until a human types the phrase, at a real
 * terminal, in this session.
 *
 * The reason is specific: this repository is worked on with AI agents, several
 * of which can be running at once, and an agent that decided on its own to
 * "just pause the new integration to be safe" would be making a production
 * decision nobody asked for. An agent has no TTY, so it cannot get past this,
 * and there is deliberately no flag that lets it — not `--force`, not `--yes`.
 * If you want it done from a script, do it by hand or change this file first.
 */
async function requireTypedConsent(phrase, whatItDoes) {
    console.log(bold("\n⚠  This command changes production state.\n"));
    console.log(`   ${whatItDoes}\n`);

    if (!process.stdin.isTTY) {
        console.error(red("   Refused: no interactive terminal."));
        console.error(dim("   This guard exists so an automated session cannot run it. Run it yourself,"));
        console.error(dim("   in a terminal, if that is what you want.\n"));
        process.exit(2);
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => {
        rl.question(`   Type ${bold(phrase)} to continue (anything else aborts): `, (a) => {
            rl.close();
            resolve(a);
        });
    });

    if (answer.trim() !== phrase) {
        console.log(amber("\n   Aborted. Nothing was changed.\n"));
        process.exit(1);
    }
    console.log("");
}

// Keep literals single-quoted: the command is wrapped in double quotes so the
// query survives cmd.exe, PowerShell and sh alike. Same helper as audit-fleet.
function d1(rawSql) {
    if (rawSql.includes('"')) throw new Error(`d1(): use single quotes in SQL literals — ${rawSql}`);
    // Flattened to one line before it reaches the shell. execSync goes through
    // cmd.exe on Windows, where a newline inside a double-quoted argument cuts
    // the command in half — the truncated query then fails with a misleading
    // "no such column" that points at the first column name.
    const sql = rawSql.replace(/\s+/g, " ").trim();
    const out = execSync(
        `npx wrangler d1 execute rioko-db --remote --json --command "${sql}"`,
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    );
    const at = out.search(/^\[/m);
    if (at < 0) throw new Error(`d1(): no JSON in wrangler output — ${out.slice(0, 200)}`);
    return JSON.parse(out.slice(at))[0].results;
}

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const amber = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const labels = new Map(
    d1("SELECT id, COALESCE(admin_label, '') AS l FROM users").map((u) => [u.id, u.l]),
);
const nameOf = (userId) => labels.get(userId) || userId;

// ── the existing integration, which is the one that must never break ─────────
function checkExisting() {
    console.log(bold("\nStripe → Moloni (the integration that is already live)\n"));

    const conns = d1(
        `SELECT user_id, status, COALESCE(invoice_cutoff, created_at) AS since
           FROM connections
          WHERE source_kind = 'stripe' AND destination_kind = 'moloni'
          ORDER BY created_at`,
    );
    if (conns.length === 0) {
        console.log(dim("  no Stripe → Moloni connections on this database"));
        return true;
    }

    // Invoicing activity, per connection, over the last week. A connection that
    // was issuing documents and stopped is the signal worth seeing; a quiet shop
    // that is always quiet is not.
    const rows = d1(
        `SELECT user_id,
                SUM(CASE WHEN created_at >= datetime('now', '-1 day') THEN 1 ELSE 0 END)  AS d1,
                SUM(CASE WHEN created_at >= datetime('now', '-7 day') THEN 1 ELSE 0 END)  AS d7,
                SUM(CASE WHEN created_at >= datetime('now', '-30 day') THEN 1 ELSE 0 END) AS d30
           FROM processed_orders
          WHERE source_kind = 'stripe' AND destination_kind = 'moloni'
          GROUP BY user_id`,
    );
    const activity = new Map(rows.map((r) => [r.user_id, r]));

    let worrying = 0;
    for (const c of conns) {
        const a = activity.get(c.user_id) ?? { d1: 0, d7: 0, d30: 0 };
        // Issued steadily over the month but nothing in 24h, on an active
        // connection: worth a look. Not proof of anything — merchants have
        // quiet days — which is why it prints as a question, not an alarm.
        const stalled = c.status === "active" && Number(a.d30) > 20 && Number(a.d1) === 0;
        if (stalled) worrying++;
        const flag = c.status !== "active" ? amber(c.status) : stalled ? amber("quiet 24h") : green("ok");
        console.log(
            `  ${flag.padEnd(20)} ${nameOf(c.user_id).padEnd(28)} ` +
            `24h=${String(a.d1).padStart(3)}  7d=${String(a.d7).padStart(4)}  30d=${String(a.d30).padStart(5)}`,
        );
    }

    // Failures on THIS connection, and only this one.
    //
    // `incidents` was the obvious table and it is the wrong one: it records the
    // merchant, not which of their connections failed. A merchant running both
    // Lodgify and Stripe → Moloni had their Lodgify problems reported here as if
    // this deploy had caused them — 74 of them, on day one, before anything was
    // deployed at all. `document_events` carries source_kind and
    // destination_kind, so it can answer the question that was actually asked.
    const incidents = d1(
        `SELECT user_id, event AS kind, COUNT(*) AS n
           FROM document_events
          WHERE created_at >= datetime('now', '-1 day')
            AND source_kind = 'stripe' AND destination_kind = 'moloni'
            AND event IN ('create_failed', 'verify_failed', 'finalize_failed')
          GROUP BY user_id, event`,
    );
    if (incidents.length) {
        console.log(bold("\n  Document failures in the last 24h"));
        for (const i of incidents) {
            console.log(`    ${red(i.kind.padEnd(28))} ${nameOf(i.user_id).padEnd(28)} x${i.n}`);
        }
    } else {
        console.log(dim("\n  no document failures in the last 24h"));
    }

    return { conns, activity, incidents, worrying };
}

// ── baseline: the only honest way to say "did WE break it?" ──────────────────
//
// An absolute verdict is worthless here — this fleet always has some incident
// open somewhere. What matters is whether anything changed when the new code
// went out. So: snapshot before deploying, compare after.
const BASELINE_PATH = ".stripe-connect-baseline.json";

function saveBaseline(state) {
    const snapshot = {
        takenAt: new Date().toISOString(),
        activity: Object.fromEntries([...state.activity].map(([k, v]) => [k, { d1: Number(v.d1), d7: Number(v.d7), d30: Number(v.d30) }])),
        incidentKinds: state.incidents.map((i) => `${i.user_id}:${i.kind}`).sort(),
    };
    writeFileSync(BASELINE_PATH, JSON.stringify(snapshot, null, 2));
    console.log(green(`\nBaseline saved to ${BASELINE_PATH} (${snapshot.takenAt}).`));
    console.log(dim("Deploy, then run --check to see what moved.\n"));
}

function compareBaseline(state) {
    if (!existsSync(BASELINE_PATH)) {
        console.log(dim(`\n  no baseline yet — run --baseline before deploying to make this comparable`));
        return true;
    }
    const base = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    console.log(bold(`\n  Against the baseline of ${base.takenAt}`));

    let regressions = 0;

    // A merchant who was invoicing yesterday and is not today.
    for (const [userId, before] of Object.entries(base.activity)) {
        const now = state.activity.get(userId);
        if (!now) continue;
        if (before.d1 > 0 && Number(now.d1) === 0) {
            regressions++;
            console.log(`    ${red("stopped")}  ${nameOf(userId).padEnd(28)} ${dim(`24h ${before.d1} → 0`)}`);
        }
    }

    // An incident kind that was not open for this merchant before.
    const beforeKinds = new Set(base.incidentKinds);
    for (const i of state.incidents) {
        const key = `${i.user_id}:${i.kind}`;
        if (!beforeKinds.has(key)) {
            regressions++;
            console.log(`    ${red("new")}      ${nameOf(i.user_id).padEnd(28)} ${i.kind}`);
        }
    }

    if (regressions === 0) console.log(`    ${green("nothing changed for the better or worse")}`);
    return regressions === 0;
}

// ── the new integration ──────────────────────────────────────────────────────
function listNew() {
    return d1(
        `SELECT id, user_id, status, destination_kind,
                json_extract(source_config_json, '$.stripe_account_id') AS acct,
                json_extract(source_config_json, '$.killswitch_prev_status') AS prev
           FROM connections
          WHERE source_kind = 'stripe_connect'
          ORDER BY created_at`,
    );
}

function showNew() {
    console.log(bold("\nStripe Connect → Moloni (the new integration)\n"));
    const rows = listNew();
    if (rows.length === 0) {
        console.log(dim("  no stripe_connect connections yet — nothing the new code can act on"));
        return;
    }
    for (const r of rows) {
        const tone = r.status === "active" ? green : r.status === "error" ? red : amber;
        console.log(`  ${tone(String(r.status).padEnd(10))} ${nameOf(r.user_id).padEnd(28)} ${r.acct ?? dim("(not connected)")}`);
    }
}

async function killswitchOff() {
    const rows = listNew();
    const live = rows.filter((r) => r.status !== "paused");
    if (live.length === 0) {
        console.log(amber("\nNothing to stop: no stripe_connect connection is running.\n"));
        return;
    }

    console.log(bold("\nWould pause:"));
    for (const r of live) console.log(`  ${nameOf(r.user_id).padEnd(28)} ${dim(r.status)}`);
    if (has("--dry-run")) {
        console.log(dim("\n--dry-run: nothing was changed.\n"));
        return;
    }
    await requireTypedConsent(
        "PARAR STRIPE CONNECT",
        `Pauses ${live.length} Stripe Connect connection(s). The existing Stripe → Moloni connections are not matched by this statement.`,
    );
    // The previous status is stored on the row so --on can put back exactly what
    // was there, rather than activating a connection that was still a draft.
    for (const r of live) {
        d1(
            `UPDATE connections
                SET status = 'paused',
                    source_config_json = json_patch(COALESCE(source_config_json, '{}'),
                                                    json_object('killswitch_prev_status', '${r.status}')),
                    updated_at = datetime('now')
              WHERE id = '${r.id}' AND source_kind = 'stripe_connect'`,
        );
        console.log(`  ${red("paused")}  ${nameOf(r.user_id)} ${dim(`(was ${r.status})`)}`);
    }
    console.log(green(`\nStopped ${live.length} Stripe Connect connection(s). No deploy needed; effective immediately.\n`));
    console.log(dim("The existing Stripe → Moloni connections were not touched by this command.\n"));
}

async function killswitchOn() {
    const rows = listNew().filter((r) => r.status === "paused");
    if (rows.length === 0) {
        console.log(amber("\nNothing to resume.\n"));
        return;
    }

    console.log(bold("\nWould resume:"));
    for (const r of rows) console.log(`  ${nameOf(r.user_id).padEnd(28)} ${dim(`→ ${r.prev ?? "draft"}`)}`);
    if (has("--dry-run")) {
        console.log(dim("\n--dry-run: nothing was changed.\n"));
        return;
    }
    await requireTypedConsent(
        "RETOMAR STRIPE CONNECT",
        `Resumes ${rows.length} Stripe Connect connection(s), each to the status it had before it was paused.`,
    );
    for (const r of rows) {
        const restore = ["draft", "active", "error"].includes(r.prev) ? r.prev : "draft";
        d1(
            `UPDATE connections SET status = '${restore}', updated_at = datetime('now')
              WHERE id = '${r.id}' AND source_kind = 'stripe_connect'`,
        );
        console.log(`  ${green(restore.padEnd(8))} ${nameOf(r.user_id)}`);
    }
    console.log("");
}

function rollbackRunbook() {
    console.log(bold("\nRollback runbook — Stripe Connect → Moloni\n"));

    let versions = "";
    try {
        versions = execSync("npx wrangler versions list --json", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch { /* wrangler not logged in, or the command shape changed */ }

    let previousId = "<previous-version-id>";
    try {
        const at = versions.search(/^[[{]/m);
        const parsed = JSON.parse(versions.slice(at));
        const list = Array.isArray(parsed) ? parsed : parsed.versions ?? [];
        // [0] is what is live now; [1] is what was live before it.
        if (list[1]?.id) previousId = list[1].id;
    } catch { /* fall through to the placeholder */ }

    console.log(`  ${bold("1. Stop the new integration")} ${dim("— seconds, no deploy, cannot touch other connections")}`);
    console.log("     node scripts/stripe-connect-killswitch.mjs --off\n");

    console.log(`  ${bold("2. Roll the Worker back to the previous version")} ${dim("— ~1 min")}`);
    console.log(`     npx wrangler versions deploy ${previousId}@100`);
    console.log(dim("     Promotes a version that already exists. Unlike `wrangler deploy`, it"));
    console.log(dim("     does not rebuild and does not drop this Worker's secrets.\n"));

    console.log(`  ${bold("3. Roll the backoffice back")} ${dim("— ~1 min")}`);
    console.log("     Cloudflare dashboard → Pages → rioko → Deployments → the previous");
    console.log("     production deployment → Rollback to this deployment.\n");

    console.log(`  ${bold("4. Git, when there is time")} ${dim("— reverts both on the next CI build")}`);
    console.log("     git revert -m 1 <merge-commit-sha> && git push\n");

    console.log(`  ${bold("Migration 0044")} ${dim("— leave it alone")}`);
    console.log(dim("     It adds three nullable columns and nothing reads them unless the new"));
    console.log(dim("     code runs. Dropping columns rewrites the table in SQLite, which is a"));
    console.log(dim("     far bigger risk than three unused columns.\n"));

    console.log(`  ${bold("Verify afterwards")}`);
    console.log("     node scripts/stripe-connect-killswitch.mjs --check\n");
}

// ── main ─────────────────────────────────────────────────────────────────────
if (has("--off")) {
    await killswitchOff();
} else if (has("--on")) {
    await killswitchOn();
} else if (has("--rollback")) {
    rollbackRunbook();
} else if (has("--baseline")) {
    saveBaseline(checkExisting());
} else if (has("--check")) {
    const state = checkExisting();
    const ok = compareBaseline(state);
    console.log(ok
        ? green("\nNothing regressed against the baseline.\n")
        : red("\nSomething moved since the baseline. Consider: npm run stripe-connect:off\n"));
    process.exitCode = ok ? 0 : 1;
} else {
    checkExisting();
    showNew();
    console.log(dim("\n--baseline before deploying · --check after · --off to stop the new one · --rollback for the runbook\n"));
}
