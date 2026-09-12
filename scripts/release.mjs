#!/usr/bin/env node
/**
 * Cuts the next version from the commits that landed since the last one.
 *
 * The changelog is the source of truth for the version the app shows, so a
 * release is: read the head entry, read every commit after the sha it records,
 * group them by conventional-commit type, write a new entry on top, and
 * regenerate the two files the backoffice imports.
 *
 *   node scripts/release.mjs --dry              see the entry without writing
 *   node scripts/release.mjs                    write CHANGELOG.md + regenerate
 *   node scripts/release.mjs --commit           ...and commit the result
 *   node scripts/release.mjs --minor --title="Day Mode"
 *
 * Bump, unless forced: a `!` or a BREAKING CHANGE trailer is major, any feat
 * is minor, anything else is a patch. Keep majors for what actually breaks a
 * merchant's contract — price, billing unit, the meaning of a setting — not
 * for a big week.
 *
 * Customer-facing notes come from a trailer in the commit body:
 *
 *     fix(stripe): key a card-paid invoice onto the payment that paid it
 *
 *     Notas: Vendas pagas por cartão deixam de ficar por facturar.
 *
 * Every `Notas:` line in the range becomes a bullet under "Para o comerciante",
 * which is the only section the merchant ever sees. A release with no such
 * line never reaches them — the right outcome for refactors and tooling.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const changelogPath = resolve(root, "CHANGELOG.md");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => {
    const hit = args.find((a) => a.startsWith(`${f}=`));
    return hit ? hit.slice(f.length + 1) : undefined;
};

const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();

// Section per conventional-commit type. Order here is the order in the entry.
const SECTIONS = [
    { heading: "Novo", types: ["feat"] },
    { heading: "Corrigido", types: ["fix", "revert"] },
    { heading: "Desempenho", types: ["perf"] },
    { heading: "Arquitectura", types: ["refactor"] },
    { heading: "Interface", types: ["style"] },
    { heading: "Documentação", types: ["docs"] },
    { heading: "Manutenção", types: ["chore", "ci", "build", "test", "config"] },
    { heading: "Outros", types: ["_other"] },
];

function parseHeadEntry(md) {
    const m = md.match(/^##\s+(?:\S+\s+)?Version\s+([\d.]+)/m);
    if (!m) throw new Error("CHANGELOG.md has no version heading");
    const after = md.slice(m.index);
    const marker = after.match(/<!--\s*release:\s*([0-9a-f]{7,40})\s*-->/i);
    return { version: m[1], commit: marker?.[1] };
}

function collect(from) {
    const FIELD = "\u0001";
    const RECORD = "\u0002";
    const raw = git("log", `${from}..HEAD`, "--no-merges", "--reverse", "--format=%h%x01%s%x01%b%x02");
    if (!raw) return [];
    return raw
        .split(RECORD)
        .map((chunk) => chunk.trim())
        .filter(Boolean)
        .map((chunk) => {
            const [sha, subject, body = ""] = chunk.split(FIELD);
            const m = subject.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/);
            return {
                sha,
                subject,
                body,
                type: m ? m[1].toLowerCase() : "_other",
                scope: m?.[2] ?? "",
                breaking: Boolean(m?.[3]) || /BREAKING CHANGE/.test(body),
                text: m ? m[4] : subject,
                // "Notas: <line>" in the commit body is the line a merchant
                // reads. Written by whoever made the change, because nobody
                // else can tell afterwards whether a change was visible.
                notes: body
                    .split(/\r?\n/)
                    .map((l) => l.match(/^\s*(?:Notas|Notes|Release-note):\s*(.+)$/i)?.[1])
                    .filter(Boolean),
            };
        });
}

function nextVersion(current, commits) {
    const [maj, min, patch] = current.split(".").map(Number);
    if (has("--version")) return val("--version");
    const forced = has("--major") ? "major" : has("--minor") ? "minor" : has("--patch") ? "patch" : null;
    const level =
        forced ??
        (commits.some((c) => c.breaking)
            ? "major"
            : commits.some((c) => c.type === "feat")
              ? "minor"
              : "patch");
    if (level === "major") return `${maj + 1}.0.0`;
    if (level === "minor") return `${maj}.${min + 1}.0`;
    return `${maj}.${min}.${patch + 1}`;
}

/** The headline commit names the release when nobody passes --title. */
function deriveTitle(commits) {
    const pick =
        commits.find((c) => c.breaking) ??
        commits.find((c) => c.type === "feat") ??
        commits.find((c) => c.type === "fix") ??
        commits[0];
    const t = pick.text.replace(/\.$/, "");
    return t.charAt(0).toUpperCase() + t.slice(1);
}

function render(version, title, commits, headSha) {
    const emoji = version.endsWith(".0.0") ? "🚀" : version.endsWith(".0") ? "✨" : "🔧";
    const date = new Date().toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
    });

    const lines = [`## ${emoji} Version ${version} — ${title} — ${date}`, "", `<!-- release: ${headSha} -->`, ""];

    const breaking = commits.filter((c) => c.breaking);
    if (breaking.length) {
        lines.push(
            `**Destaque:** ${breaking.map((c) => c.text).join("; ")}.`,
            "",
        );
    }

    // The merchant section comes first, and only exists when a commit said
    // something to them. No placeholder: an entry without it is a release the
    // merchant is never shown, which is the right outcome for tooling and
    // refactors.
    const notes = commits.flatMap((c) => c.notes);
    if (notes.length) {
        lines.push("### Para o comerciante", "", ...notes.map((n) => `- ${n}`), "");
    }

    for (const section of SECTIONS) {
        const hits = commits.filter((c) => section.types.includes(c.type));
        if (!hits.length) continue;
        lines.push(`### ${section.heading}`, "");
        for (const c of hits) {
            lines.push(c.scope ? `- **${c.scope}** — ${c.text}` : `- ${c.text}`);
        }
        lines.push("");
    }
    return lines.join("\n");
}

// ---------------------------------------------------------------------------

const md = readFileSync(changelogPath, "utf8");
const head = parseHeadEntry(md);
const from = val("--from") ?? head.commit;
if (!from) {
    console.error(
        `[release] the head entry (v${head.version}) records no "<!-- release: sha -->" marker.\n` +
            `          add one, or pass --from=<sha> to say where this release starts.`,
    );
    process.exit(1);
}

const commits = collect(from);
if (commits.length === 0) {
    console.log(`[release] nothing new since ${from} (v${head.version}). Nothing to do.`);
    process.exit(0);
}

const version = nextVersion(head.version, commits);
const title = val("--title") ?? deriveTitle(commits);
const headSha = git("rev-parse", "--short", "HEAD");
const entry = render(version, title, commits, headSha);

if (has("--dry")) {
    console.log(entry);
    console.log(`[release] ${commits.length} commits, v${head.version} -> v${version} (dry run)`);
    process.exit(0);
}

// Insert above the first existing entry, keeping the file's intro block.
const firstEntry = md.search(/^##\s+(?:\S+\s+)?Version\s/m);
writeFileSync(changelogPath, `${md.slice(0, firstEntry)}${entry}\n${md.slice(firstEntry)}`, "utf8");

execFileSync(process.execPath, [resolve(root, "backoffice/scripts/sync-version.mjs")], {
    cwd: root,
    stdio: "inherit",
});

console.log(`[release] v${head.version} -> v${version} — ${commits.length} commits — ${title}`);

if (has("--commit")) {
    git(
        "add",
        "CHANGELOG.md",
        "backoffice/src/lib/version.ts",
        "backoffice/src/lib/changelog.generated.ts",
    );
    git("commit", "-m", `docs(changelog): v${version} — ${title}`);
    if (has("--tag")) git("tag", `v${version}`);
    console.log(`[release] committed${has("--tag") ? ` and tagged v${version}` : ""}.`);
}
