import { describe, it, expect } from "vitest";
import { formatMoney, annualSavingPct, monthlyEquivalent } from "./billing-display";

const eur = (amount_cents: number) => ({ amount_cents, currency: "eur" });

/** Intl separates the amount from the symbol with U+00A0, which is invisible in
 *  a diff — so the assertions below compare on a plain space. */
const norm = (s: string | null) => (s === null ? null : s.replace(/ /g, " "));

describe("formatMoney", () => {
    it("writes the current price the way each language does", () => {
        expect(norm(formatMoney(eur(750), "pt"))).toBe("7,50 €");
        expect(norm(formatMoney(eur(750), "en"))).toBe("€7.50");
    });

    it("drops the decimals on a whole amount", () => {
        // "75 €", not "75,00 €": the cards printed it by hand this way, and two
        // new zeros would read as a change of price rather than of code.
        expect(norm(formatMoney(eur(7500), "pt"))).toBe("75 €");
        expect(norm(formatMoney(eur(5000), "pt"))).toBe("50 €");
    });

    it("takes a full tag as well as a bare language", () => {
        // The cards pass the `dateLocale` message ("pt-PT"), so adopting this
        // helper had to leave their formatting exactly where it was.
        expect(formatMoney(eur(750), "pt-PT")).toBe(formatMoney(eur(750), "pt"));
    });

    it("says nothing rather than something wrong", () => {
        expect(formatMoney(null, "pt")).toBeNull();
        expect(formatMoney(undefined, "pt")).toBeNull();
        expect(formatMoney({ amount_cents: Number.NaN, currency: "eur" }, "pt")).toBeNull();
        // An unsupported currency code throws inside Intl; the card shows "—".
        expect(formatMoney({ amount_cents: 750, currency: "not-a-currency" }, "pt")).toBeNull();
    });

    it("honours a currency that is not the euro", () => {
        expect(formatMoney({ amount_cents: 750, currency: "usd" }, "en")).toContain("7.50");
    });
});

describe("annualSavingPct", () => {
    it("is the 17% the badge used to state, when the prices are the ones it stated it for", () => {
        expect(annualSavingPct(eur(750), eur(7500))).toBe(17);
    });

    it("is computed per pair, not repeated from the Shopify pair", () => {
        // The legacy 5/50 pair saves the same two months, and the badge said
        // "Poupa 17%" on every pair regardless of what that pair costs.
        expect(annualSavingPct(eur(500), eur(5000))).toBe(17);
        expect(annualSavingPct(eur(1000), eur(9000))).toBe(25);
    });

    it("claims nothing when the year is not cheaper", () => {
        expect(annualSavingPct(eur(750), eur(9000))).toBeNull();
        expect(annualSavingPct(eur(750), eur(10000))).toBeNull();
    });

    it("claims nothing when a price is missing", () => {
        expect(annualSavingPct(null, eur(7500))).toBeNull();
        expect(annualSavingPct(eur(750), null)).toBeNull();
        expect(annualSavingPct(eur(0), eur(7500))).toBeNull();
    });
});

describe("monthlyEquivalent", () => {
    it("spreads the yearly price over twelve months", () => {
        expect(monthlyEquivalent(eur(7500))).toEqual(eur(625));
        expect(monthlyEquivalent(eur(5000))).toEqual({ amount_cents: 417, currency: "eur" });
    });

    it("has nothing to spread without a yearly price", () => {
        expect(monthlyEquivalent(null)).toBeNull();
        expect(monthlyEquivalent(eur(0))).toBeNull();
    });
});
