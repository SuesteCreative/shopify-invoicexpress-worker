import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CHANGELOG, CHANGELOG_PUBLIC } from "./changelog.generated";
import { RIOKO_VERSION } from "./version";
// The real parser and the real path, not a copy of either: this test exists to
// catch drift, and a second implementation of the parser would be drift.
import { parse, changelogPath } from "../../scripts/changelog-parse.mjs";

/**
 * Both files are generated from CHANGELOG.md by scripts/sync-version.mjs. The
 * check is that they still agree with each other and with semver: a changelog
 * heading written in a shape the parser does not recognise fails silently
 * otherwise — the entry simply disappears from the page.
 */

const semver = (v: string) => v.split(".").map(Number);

describe("changelog", () => {
    /**
     * The check that matters, and the one that was missing: the generated files
     * are compared to CHANGELOG.md, not only to each other.
     *
     * "Para o comerciante" is written by hand after `npm run release` cuts the
     * entry — the release script fills the internal sections from commit
     * subjects, but the merchant lines come from `Notas:` trailers nobody
     * writes. Editing the markdown and forgetting to re-run sync-version.mjs
     * left every other test passing while the panel served the previous
     * version's notes. Nothing pointed at it.
     */
    it("is regenerated from the changelog it claims to come from", () => {
        expect(parse(readFileSync(changelogPath, "utf8"))).toEqual(CHANGELOG);
    });

    it("has the head entry as the running version", () => {
        expect(CHANGELOG[0].version).toBe(RIOKO_VERSION);
    });

    it("parses a version, a date and a body out of every entry", () => {
        for (const e of CHANGELOG) {
            expect(e.version, `version on ${e.title}`).toMatch(/^\d+\.\d+\.\d+$/);
            expect(e.date, `date on v${e.version}`).toMatch(/^[A-Z][a-z]+ \d{1,2}, \d{4}$/);
            expect(e.body.length, `body on v${e.version}`).toBeGreaterThan(0);
        }
    });

    it("runs newest first", () => {
        for (let i = 1; i < CHANGELOG.length; i++) {
            const [aMaj, aMin, aPatch] = semver(CHANGELOG[i - 1].version);
            const [bMaj, bMin, bPatch] = semver(CHANGELOG[i].version);
            const older =
                aMaj > bMaj ||
                (aMaj === bMaj && aMin > bMin) ||
                (aMaj === bMaj && aMin === bMin && aPatch >= bPatch);
            expect(older, `v${CHANGELOG[i - 1].version} before v${CHANGELOG[i].version}`).toBe(
                true,
            );
        }
    });

    it("keeps the merchant feed to entries that wrote for a merchant", () => {
        expect(CHANGELOG_PUBLIC.length).toBeGreaterThan(0);
        for (const e of CHANGELOG_PUBLIC) {
            expect(e.publicBody.length, `public body on v${e.version}`).toBeGreaterThan(0);
            // Every merchant line is also in the full entry: one source, two
            // readings of it, never two texts to keep in step.
            for (const b of e.publicBody) expect(e.body).toContainEqual(b);
        }
        const silent = CHANGELOG.filter((e) => e.publicBody.length === 0);
        expect(silent.length, "some releases say nothing to a merchant").toBeGreaterThan(0);
    });

    it("gives the release marker of every entry that carries one a real sha", () => {
        for (const e of CHANGELOG.filter((x) => x.commit)) {
            expect(e.commit, `marker on v${e.version}`).toMatch(/^[0-9a-f]{7,40}$/);
        }
    });
});
