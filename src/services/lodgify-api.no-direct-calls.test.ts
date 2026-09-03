import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * The guard that outlives us.
 *
 * Lodgify can only allowlist us by IP address, and neither Workers nor Pages has
 * a fixed egress one — so a single `fetch("https://api.lodgify.com/…")` anywhere
 * in this repo leaves from an unallowlisted address and re-earns the block that
 * cost Origos and Overbuilding a month of booking sync.
 *
 * That failure is silent: the call works in dev, works on the first deploy, and
 * then one day Lodgify flags the pattern again and nobody connects the two. A
 * grep is the only thing that catches it, so the grep is a test.
 *
 * If this fails: route the call through `lodgifyFetch` from
 * `src/services/lodgify-api.ts` instead of writing the host yourself.
 */

// Vitest runs from the repo root. If that ever stops being true the second test
// below fails loudly rather than this guard quietly scanning an empty tree.
const REPO_ROOT = process.cwd();

/** The one module allowed to name Lodgify's origin, plus the tests about it. */
const ALLOWED = [
  join("src", "services", "lodgify-api.ts"),
];

const SCAN_ROOTS = [
  join("src"),
  join("backoffice", "src"),
];

const CODE_EXT = /\.(ts|tsx|js|mjs|jsx)$/;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (name === "node_modules" || name === ".next" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (CODE_EXT.test(name)) out.push(full);
  }
  return out;
}

describe("no direct Lodgify calls outside the gateway module", () => {
  it("finds the host literal only in lodgify-api.ts", () => {
    const offenders: string[] = [];

    for (const root of SCAN_ROOTS) {
      for (const file of walk(join(REPO_ROOT, root))) {
        const rel = relative(REPO_ROOT, file);
        // Tests may quote the host to prove a call is REFUSED.
        if (rel.includes(".test.")) continue;
        if (ALLOWED.some(a => rel === a || rel === a.split("/").join(sep))) continue;
        if (readFileSync(file, "utf8").includes("api.lodgify.com")) offenders.push(rel);
      }
    }

    expect(offenders, `route these through lodgifyFetch(): ${offenders.join(", ")}`).toEqual([]);
  });

  it("is actually scanning something — a guard that greps nothing passes forever", () => {
    const scanned = SCAN_ROOTS.flatMap(r => walk(join(REPO_ROOT, r)));
    expect(scanned.length).toBeGreaterThan(50);
    expect(scanned.some(f => f.endsWith(join("services", "lodgify-api.ts")))).toBe(true);
  });
});
