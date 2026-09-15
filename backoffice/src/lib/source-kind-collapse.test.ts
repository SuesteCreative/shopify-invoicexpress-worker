import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative } from "node:path";
import { sourceKindOrNull, destinationKindOrNull, SOURCE_KINDS } from "./connection-kinds";

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
const API_ROOT = resolve(HERE, "../app/api");

function routeFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = resolve(dir, entry);
        if (statSync(full).isDirectory()) out.push(...routeFiles(full));
        else if (entry === "route.ts") out.push(full);
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

/** An `includes([...]) ? raw : "<kind>"` whitelist, which goes stale the same way. */
const STALE_WHITELIST = /\[[^\]]*["'](?:shopify|stripe|lodgify|eupago)["'][^\]]*\]\s*\.includes\([^)]*\)\s*\?[^:]*:\s*["'](?:shopify|stripe|stripe_connect|lodgify|eupago)["']/;

describe("no API route silently redirects one connection kind to another", () => {
    const files = routeFiles(API_ROOT);

    it("finds the route files at all, so a passing run means something", () => {
        expect(files.length).toBeGreaterThan(20);
    });

    it("has no `=== \"a\" ? \"a\" : \"b\"` source-kind collapse left", () => {
        const offenders = files
            .filter((f) => COLLAPSE.test(codeOnly(readFileSync(f, "utf8"))))
            .map((f) => relative(API_ROOT, f).replace(/\\/g, "/"));
        expect(offenders).toEqual([]);
    });

    it("has no hand-maintained kind whitelist with a fallback left", () => {
        const offenders = files
            .filter((f) => STALE_WHITELIST.test(codeOnly(readFileSync(f, "utf8"))))
            .map((f) => relative(API_ROOT, f).replace(/\\/g, "/"));
        expect(offenders).toEqual([]);
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
