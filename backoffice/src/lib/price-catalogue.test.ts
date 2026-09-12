import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { requiredPrices, statusOf, CURRENT_MONTHLY_CENTS, CURRENT_ANNUAL_CENTS } from "./price-catalogue";
import { priceLookupFor } from "./billing-prices";
import { SOURCE_TO_CONNECTION_KEY, CONNECTION_KEY_TO_SOURCE } from "./subscription-key";

/**
 * One rule, three lists.
 *
 * A pair that a merchant can set up through a guided page must be sellable:
 * a key in both direction maps and a price in the catalogue. Five pairs had the
 * page and none of the rest — `shopify:moloni`, `shopify:vendus`,
 * `stripe:vendus`, `lodgify:vendus`, `eupago:invoicexpress` — so the merchant
 * connected them and was never asked for money, and pressing subscribe answered
 * 400. The lists are read from the filesystem rather than restated here,
 * because a fourth list is how they drifted apart in the first place.
 */

const SOURCE_SLUGS = ["shopify", "stripe-connect", "stripe", "lodgify", "eupago"];
const DEST_SLUGS = ["ix", "moloni", "vendus"];

/** The integrations directory holds pair wizards and a few shared tools
 *  (`tag-routing`, `ix-overrides`, `moloni-mappings`). A pair is a directory
 *  that splits cleanly into a source we support and a destination we support. */
function guidedPairPages(): string[] {
    const dir = new URL("../app/[locale]/(dashboard)/integrations", import.meta.url);
    return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter((name) => SOURCE_SLUGS.some((s) =>
            name.startsWith(`${s}-`) && DEST_SLUGS.includes(name.slice(s.length + 1))));
}

/** "faturacao" is the billing page, which sells the Shopify pair under its own
 *  name; the wizard for that same pair is `shopify-ix`. Both mean one pair. */
const PAGE_ALIAS: Record<string, string> = { faturacao: "shopify-ix" };

describe("the price catalogue", () => {
    it("finds the guided pages it is supposed to check", () => {
        const pages = guidedPairPages();
        expect(pages.length).toBeGreaterThanOrEqual(12);
        expect(pages).toContain("stripe-vendus");
        expect(pages).not.toContain("tag-routing");
        expect(pages).not.toContain("ix-overrides");
    });

    it("prices every pair that has a guided page", () => {
        for (const page of guidedPairPages()) {
            const key = SOURCE_TO_CONNECTION_KEY[page];
            expect(key, `${page} has no connection key`).toBeTruthy();
            expect(PAGE_ALIAS[CONNECTION_KEY_TO_SOURCE[key]] ?? CONNECTION_KEY_TO_SOURCE[key],
                `${key} does not map back to ${page}`).toBe(page);
            expect(priceLookupFor(page, "monthly"), `${page} has no monthly price`).toBeTruthy();
            expect(priceLookupFor(page, "annual"), `${page} has no annual price`).toBeTruthy();
        }
    });

    it("sells nothing that has no page to sell it", () => {
        const pages = new Set(guidedPairPages());
        for (const source of Object.values(CONNECTION_KEY_TO_SOURCE)) {
            expect(pages.has(PAGE_ALIAS[source] ?? source), `${source} is sellable with no page`).toBe(true);
        }
    });

    it("gives every entry a unique lookup key", () => {
        const rows = requiredPrices();
        const keys = rows.map((r) => r.lookup);
        expect(keys.every(Boolean), "a catalogue row with no key").toBe(true);
        expect(new Set(keys).size).toBe(rows.length);
        expect(rows.length).toBe(Object.keys(CONNECTION_KEY_TO_SOURCE).length * 2);
    });

    it("prices everything at the current plan", () => {
        for (const r of requiredPrices()) {
            expect(r.amountCents).toBe(r.plan === "annual" ? CURRENT_ANNUAL_CENTS : CURRENT_MONTHLY_CENTS);
            expect(r.interval).toBe(r.plan === "annual" ? "year" : "month");
            expect(r.productName).toMatch(/^Rioko 2\.0 \|\| .+ - .+$/);
            expect(r.productDescription).toContain("||");
        }
    });
});

describe("what the catalogue says about a live price", () => {
    const req = requiredPrices().find((r) => r.plan === "monthly")!;

    it("passes a price at the expected amount", () => {
        expect(statusOf(req, { active: true, unit_amount: CURRENT_MONTHLY_CENTS })).toBe("ok");
    });

    it("catches a price at the wrong amount", () => {
        // stripe-ix-monthly and stripe-moloni-monthly sat at 500 for months and
        // reported "ok", so both pairs were sold at the old plan's price.
        expect(statusOf(req, { active: true, unit_amount: 500 })).toBe("wrong_amount");
    });

    it("still reports missing and archived first", () => {
        expect(statusOf(req, null)).toBe("missing");
        expect(statusOf(req, { active: false, unit_amount: CURRENT_MONTHLY_CENTS })).toBe("archived");
        expect(statusOf({ ...req, lookup: null }, null)).toBe("no_key");
    });
});
