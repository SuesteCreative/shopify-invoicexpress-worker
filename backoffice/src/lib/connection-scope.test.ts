import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { SOURCE_TO_CONNECTION_KEY, CONNECTION_KEY_TO_SOURCE, DEFAULT_CONNECTION_KEY } from "./subscription-key";

/**
 * A payment acts on the connection it paid for, and on no other.
 *
 * An account can run several integrations at once and suspend one of them
 * deliberately. `UPDATE connections SET status='active' WHERE user_id = ?` put
 * that one back on the air because a DIFFERENT integration was paid for — and a
 * connection on the air issues fiscal documents. The same statement stamped this
 * subscription's start date as the invoice cutoff of every other connection,
 * which decides which of the merchant's past sales get invoiced at all.
 *
 * Checked against the source because the writes live inside long async handlers
 * full of Stripe calls: extracting them purely to test them would be more code
 * than the writes themselves, and the property is a property of the SQL.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** Each `UPDATE connections … ;`-ish statement, as one whitespace-collapsed string. */
function connectionUpdates(source: string): string[] {
    const out: string[] = [];
    const re = /UPDATE\s+connections\b[\s\S]*?`/gi;
    for (const m of source.matchAll(re)) {
        out.push(m[0].replace(/\s+/g, " ").trim());
    }
    return out;
}

describe("writes to connections name the connection", () => {
    it("link-subscription scopes every connections write to one pair", () => {
        const src = readFileSync(resolve(HERE, "./link-subscription.ts"), "utf8");
        const updates = connectionUpdates(src);

        // If this drops to zero the test has stopped testing anything.
        expect(updates.length).toBeGreaterThan(0);

        for (const sql of updates) {
            expect(sql, `unscoped: ${sql}`).toMatch(/source_kind\s*=\s*\?/);
            expect(sql, `unscoped: ${sql}`).toMatch(/destination_kind\s*=\s*\?/);
        }
    });

    it("the Stripe webhook releases the paid connection by name", () => {
        const src = readFileSync(resolve(HERE, "../app/api/webhooks/stripe/route.ts"), "utf8");
        const updates = connectionUpdates(src);

        const releases = updates.filter((s) => /SET\s+status\s*=\s*'active'/i.test(s));
        expect(releases.length).toBeGreaterThan(0);

        // The scoped one has to exist: it is what stops a payment for one
        // integration resurrecting another.
        expect(releases.some((s) => /source_kind\s*=\s*\?/.test(s) && /destination_kind\s*=\s*\?/.test(s))).toBe(true);

        // Exactly one account-wide release survives, and it is the deliberate
        // net for a connection_key that names no connection this account has —
        // a merchant who paid must never stay paused because the key resolved a
        // shade differently. More than one means the net has been copied into a
        // path that has a key to use.
        const accountWide = releases.filter((s) => !/source_kind/.test(s));
        expect(accountWide.length).toBe(1);
    });

    it("leaves the legacy pause account-wide, which is its declared scope", () => {
        // `integrations.is_paused` belongs to the account by decision, not by
        // omission: the pause toggle writes that row, so projecting it per
        // connection would let a connection that never stated one silently
        // resume a paused account.
        const src = readFileSync(resolve(HERE, "../app/api/webhooks/stripe/route.ts"), "utf8");
        expect(src).toMatch(/UPDATE integrations SET is_paused=0[\s\S]*?WHERE user_id=\?/);
    });
});

describe("the page-to-connection map bills the right pair", () => {
    // Farracemota, 10/09/2026: a Lodgify+InvoiceXpress payment was filed against
    // `shopify:invoicexpress`, a connection that account does not have, and the
    // billing page — reading the connection it DOES have — showed it suspended.
    // A pair missing from either map is that bug, waiting for its merchant.

    it("is a true inverse, so a page round-trips through its key", () => {
        for (const [page, key] of Object.entries(SOURCE_TO_CONNECTION_KEY)) {
            // "", "faturacao" and "shopify-ix" are three names for the Shopify
            // pair, so that key cannot round-trip to one of them and does not
            // have to. Every key with a single page must.
            if (key === DEFAULT_CONNECTION_KEY) continue;
            expect(CONNECTION_KEY_TO_SOURCE[key], `${key} has no page`).toBe(page);
        }
    });

    it("has a page for every key it can produce", () => {
        for (const key of Object.values(SOURCE_TO_CONNECTION_KEY)) {
            expect(CONNECTION_KEY_TO_SOURCE[key], `${key} has no page`).toBeTruthy();
        }
    });

    it("covers both Stripe kinds separately, into both destinations", () => {
        // The pair that started this: `stripe` and `stripe_connect` are separate
        // integrations and separate subscriptions, never one key.
        expect(SOURCE_TO_CONNECTION_KEY["stripe-ix"]).toBe("stripe:invoicexpress");
        expect(SOURCE_TO_CONNECTION_KEY["stripe-connect-ix"]).toBe("stripe_connect:invoicexpress");
        expect(SOURCE_TO_CONNECTION_KEY["stripe-moloni"]).toBe("stripe:moloni");
        expect(SOURCE_TO_CONNECTION_KEY["stripe-connect-moloni"]).toBe("stripe_connect:moloni");
    });
});
