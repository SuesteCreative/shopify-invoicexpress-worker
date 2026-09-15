import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative } from "node:path";
import { sourceKindOrNull, destinationKindOrNull, SOURCE_KINDS, DESTINATION_KINDS } from "./connection-kinds";

/**
 * A route may not decide, on its own, which connection a request meant.
 *
 * The pattern that has to stay dead is the normalizing ternary:
 *
 *     const sourceKind = body.source_kind === "shopify" ? "shopify" : "stripe";
 *
 * It reads like a default and behaves like a redirect. A request naming
 * `lodgify` or `stripe_connect` did not fail — it silently addressed a DIFFERENT
 * connection of the same account, and then read from it, wrote to it, or
 * deleted it. Seven routes carried a version of it:
 *
 *   - `ix-overrides` turned every non-Shopify, non-`stripe` kind into SHOPIFY,
 *     so a Stripe Connect product override landed on the shop's products;
 *   - `document-sets-user` fell back to LODGIFY, and the tag-routing page asks
 *     it with `stripe_connect` — so a Connect merchant building a rule was shown
 *     the Lodgify connection's series, read with the Lodgify connection's Moloni
 *     credentials;
 *   - `vendus-destination` fell back to STRIPE, and the Lodgify→Vendus wizard
 *     sends `lodgify` — so that merchant's Vendus API key was stored on, and
 *     later deleted from, their `stripe:vendus` connection;
 *   - `moloni-oauth/start` fell back to STRIPE_CONNECT, so a request naming
 *     `stripe` wrote Moloni client id, client secret and the single-use
 *     `oauth_state` onto a connection nobody asked to authorise.
 *
 * Absent is still a default — a caller that names nothing predates the
 * parameter. Present-and-unknown is a caller bug, and the answer to a caller bug
 * is 400, not another account's connection.
 *
 * Checked statically because it costs nothing to check statically, and because
 * the next route to be written will copy whichever neighbour it opens first.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(HERE, "..");

/**
 * Routes AND the pages that call them.
 *
 * Scanning `app/api/**​/route.ts` alone was half a guard. A route that refuses an
 * unknown kind protects nothing when the PAGE collapses the value before
 * sending: the route then receives a perfectly valid kind — the wrong one — and
 * the 400 never fires. `ix-overrides/page.tsx` had a whitelist missing
 * `stripe_connect`, so a Connect merchant reaching that screen would have had
 * their product overrides written onto the account's Shopify products, through a
 * route this very file certifies as safe.
 */
function scannedFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === ".next") continue;
        const full = resolve(dir, entry);
        if (statSync(full).isDirectory()) out.push(...scannedFiles(full));
        else if (entry === "route.ts" || entry === "page.tsx" || /\.tsx$/.test(entry)) out.push(full);
    }
    return out;
}

/**
 * Code only. Every fix above left a comment quoting the line it replaced, and a
 * scanner that reads comments would flag its own documentation and push the next
 * person to delete the explanation rather than keep it.
 */
function codeOnly(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * `X === "<kind>" ? "<kind>" : "<other kind>"` — a named kind steered to a
 * different one. Deliberately narrow: it matches the shape that caused this,
 * not every ternary that mentions a kind.
 */
const COLLAPSE = new RegExp(
    `===\\s*["'](${SOURCE_KINDS.join("|")})["']\\s*\\?\\s*["']\\1["']\\s*:\\s*["'](${SOURCE_KINDS.join("|")})["']`,
);

/**
 * The same shape on the DESTINATION axis.
 *
 * `destination_kind === "moloni" ? "moloni" : "invoicexpress"` turned the
 * Stripe→Vendus wizard's stated destination into InvoiceXpress, and left the
 * tag-routing page saving a Vendus merchant's rule against their InvoiceXpress
 * pipeline. The source-side regex could never have seen it.
 */
const COLLAPSE_DESTINATION = new RegExp(
    `===\\s*["'](${DESTINATION_KINDS.join("|")})["']\\s*\\?\\s*["']\\1["']\\s*:\\s*["'](${DESTINATION_KINDS.join("|")})["']`,
);

/** An `includes([...]) ? raw : "<kind>"` whitelist, which goes stale the same way. */
const STALE_WHITELIST = /\[[^\]]*["'](?:shopify|stripe|lodgify|eupago)["'][^\]]*\]\s*\.includes\([^)]*\)\s*\?[^:]*:\s*["'](?:shopify|stripe|stripe_connect|lodgify|eupago)["']/;

describe("nothing silently redirects one connection kind to another", () => {
    const files = scannedFiles(SRC_ROOT);
    const offendersOf = (re: RegExp) => files
        .filter((f) => re.test(codeOnly(readFileSync(f, "utf8"))))
        .map((f) => relative(SRC_ROOT, f).replace(/\\/g, "/"));

    it("scans the routes AND the pages that call them", () => {
        // A guard that reads only one side of the call certifies the wrong half.
        expect(files.filter((f) => f.endsWith("route.ts")).length).toBeGreaterThan(20);
        expect(files.filter((f) => f.endsWith("page.tsx")).length).toBeGreaterThan(10);
    });

    it("has no `=== \"a\" ? \"a\" : \"b\"` source-kind collapse left", () => {
        expect(offendersOf(COLLAPSE)).toEqual([]);
    });

    it("has no destination-kind collapse left", () => {
        expect(offendersOf(COLLAPSE_DESTINATION)).toEqual([]);
    });

    it("has no hand-maintained kind whitelist with a fallback left", () => {
        expect(offendersOf(STALE_WHITELIST)).toEqual([]);
    });
});

describe("the rule those routes use instead", () => {
    it("keeps the route's historical default when the caller names nothing", () => {
        for (const absent of [undefined, null, ""]) {
            expect(sourceKindOrNull(absent, "stripe")).toBe("stripe");
            expect(sourceKindOrNull(absent, "lodgify")).toBe("lodgify");
        }
    });

    it("returns every kind it is given, rather than the default", () => {
        for (const kind of SOURCE_KINDS) {
            expect(sourceKindOrNull(kind, "stripe")).toBe(kind);
        }
    });

    it("answers null for a kind it does not know, so the caller can 400", () => {
        // The four that used to be silently rewritten, plus the shapes a buggy
        // caller actually sends.
        for (const bogus of ["stripeconnect", "Stripe", "stripe_connect ", "vendus", 7, {}, true]) {
            expect(sourceKindOrNull(bogus, "stripe")).toBeNull();
        }
    });

    it("does the same on the destination side", () => {
        expect(destinationKindOrNull(undefined, "invoicexpress")).toBe("invoicexpress");
        expect(destinationKindOrNull("vendus", "invoicexpress")).toBe("vendus");
        expect(destinationKindOrNull("moloni", "invoicexpress")).toBe("moloni");
        // The one that was rewritten: the Stripe→Vendus wizard states `vendus`
        // and used to have it turned into `invoicexpress`.
        expect(destinationKindOrNull("invoicexpres", "invoicexpress")).toBeNull();
    });
});

describe("Moloni OAuth is offered through its two doors and no others", () => {
    // Which authentication a Moloni connection uses is decided by the door, not
    // by the date: Stripe Connect and the public Lodgify onboarding authorise by
    // OAuth; the three dashboard wizards use the password grant, by decision of
    // 10/09/2026. This gate has been wrong both ways — first collapsing every
    // other kind onto the Connect row, then accepting any known kind at all — so
    // the allowed set is pinned rather than trusted.
    const route = codeOnly(readFileSync(
        resolve(SRC_ROOT, "app/api/integrations/moloni-oauth/start/route.ts"), "utf8",
    ));

    it("names exactly stripe_connect and lodgify", () => {
        const m = route.match(/MOLONI_OAUTH_SOURCES\s*=\s*\[([^\]]*)\]/);
        expect(m, "the allowed set must be stated, not implied").not.toBeNull();
        const kinds = m![1].split(",").map((s) => s.trim().replace(/["']/g, "")).filter(Boolean).sort();
        expect(kinds).toEqual(["lodgify", "stripe_connect"]);
    });

    it("actually refuses a kind outside it", () => {
        // A stated set nobody checks is decoration.
        expect(route).toMatch(/!\s*\(MOLONI_OAUTH_SOURCES[^)]*\)\.includes\(sourceKind\)/);
    });
});
