import { describe, it, expect } from "vitest";
import { mappedProductId } from "./moloni-destination";

/**
 * Which Moloni product a line is mapped to, when the reference is not a key.
 *
 * Measured on Hyrox Training Portugal, 15/09/2026. Six Stripe sales, six
 * documents, six references `pi_3UF…` — because a bare PaymentIntent carries no
 * price, so the source synthesizes one line with `sku = pi.id`, unique per sale.
 * `fetchRicherTaxSource` is the designed answer and it does not reach here: it
 * only grafts the Stripe invoice's lines when those lines carry tax, and this
 * account has no Stripe Tax, so nothing ever carries any.
 *
 * The consequence was not only unmappable lines. With no mapping the line takes
 * the source-derived rate, and the merchant's nutrition consultations — exempt
 * under art. 9.º, already set up in their own Moloni catalogue at 0% with M07 —
 * would go out at the connection's default 23%.
 *
 * So a mapping row may name the description too. It decides nothing about tax:
 * it finds the product, and the product's own rule drives the line, exactly as a
 * reference-keyed mapping always has.
 */

const line = (over: Partial<any> = {}): any => ({
    sku: "pi_3UFhWaD8iWUtfjIg1gEhvpEN",
    product_id: 0,
    variant_id: 0,
    title: "Consulta de Nutrição - Inicial",
    ...over,
});

describe("mappedProductId", () => {
    it("matches the line's description when the reference is a per-sale id", () => {
        const map = new Map([["Consulta de Nutrição - Inicial", 226511142]]);
        expect(mappedProductId(map, line())).toBe(226511142);
    });

    it("ignores the merchant's capitalisation", () => {
        const map = new Map([["consulta de nutrição - INICIAL", 226511142]]);
        expect(mappedProductId(map, line())).toBe(226511142);
    });

    it("prefers the reference, which is the more specific of the two", () => {
        const map = new Map([
            ["SKU-CONSULTA", 999],
            ["Consulta de Nutrição - Inicial", 226511142],
        ]);
        expect(mappedProductId(map, line({ sku: "SKU-CONSULTA" }))).toBe(999);
    });

    it("leaves an unmapped line unmapped, so it keeps the source-derived rate", () => {
        // The regression this must not cause: a 69 € membership is 23%, and a
        // description that matches nothing must not acquire someone's exemption.
        const map = new Map([["Consulta de Nutrição - Inicial", 226511142]]);
        expect(mappedProductId(map, line({ title: "Subscription update" }))).toBeNull();
    });

    it("says nothing when the account mapped nothing", () => {
        expect(mappedProductId(undefined, line())).toBeNull();
        expect(mappedProductId(new Map(), line())).toBeNull();
    });

    it("does not treat a blank description as a key", () => {
        const map = new Map([["", 123], ["   ", 456]]);
        expect(mappedProductId(map, line({ title: "" }))).toBeNull();
        expect(mappedProductId(map, line({ title: "   " }))).toBeNull();
    });
});
