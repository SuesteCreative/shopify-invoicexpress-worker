import { describe, it, expect } from "vitest";
import { taxRateForItem } from "./moloni-destination";
import type { AdapterCtx } from "../types";

/**
 * Which VAT rate a line carries, when four sources disagree.
 *
 * Measured on a live document, 09/09/2026: a Stripe Connect connection
 * configured at 23% issued a 12,00 € sale at 0% with an exemption code, because
 * the ACCOUNT's legacy `integrations` row — belonging to an unrelated Shopify
 * shop — carried `force_tax_rate = 0`. The merchant had typed 23 into the
 * wizard, whose help text promises it applies "when Stripe sends no VAT", and it
 * never reached the document.
 *
 * Nothing about that is visible afterwards: a 0% line with an exemption code is
 * a perfectly well-formed invoice. It is simply the wrong one.
 */

const item = (over: Partial<any> = {}): any => ({
    sku: "SKU1",
    product_id: 1,
    variant_id: 1,
    unit_price: 12,
    tax: { name: "VAT", value: 0, unit_amount: 0 },
    ...over,
});

const ctx = (config: any, destinationConfig: any): AdapterCtx =>
    ({ apiKey: "", config, destinationConfig } as unknown as AdapterCtx);

describe("taxRateForItem — precedence", () => {
    it("uses the connection's own rate when the account forces another", () => {
        // The regression. force_tax_rate belongs to the account's Shopify shop;
        // this sale belongs to a different business entirely.
        const rate = taxRateForItem(item(), ctx({ force_tax_rate: 0 }, { default_vat_rate: 23 }));
        expect(rate).toBe(23);
    });

    it("still honours the account's forced rate when the connection states none", () => {
        // Unchanged for every connection invoicing today: the shared flag keeps
        // governing anything that has not spoken for itself.
        expect(taxRateForItem(item(), ctx({ force_tax_rate: 6 }, {}))).toBe(6);
        expect(taxRateForItem(item(), ctx({ force_tax_rate: 0 }, {}))).toBe(0);
    });

    it("lets the payment's own tax beat the connection's default", () => {
        // A default is a fallback. What the payment actually charged is a fact.
        const taxed = item({ tax: { name: "VAT", value: 6, unit_amount: 0.68 } });
        expect(taxRateForItem(taxed, ctx({}, { default_vat_rate: 23 }))).toBe(6);
    });

    it("falls back to exempt when nobody states a rate", () => {
        expect(taxRateForItem(item(), ctx({}, {}))).toBe(0);
    });

    it("treats a shipping line by its own forced rate", () => {
        // Shipping is a line with no SKU and no product or variant id.
        const shipping = item({ sku: "", product_id: null, variant_id: null });
        expect(taxRateForItem(shipping, ctx({ force_shipping_tax_rate: 6, force_tax_rate: 23 }, {}))).toBe(6);
    });

    it("lets the connection's rate win on a shipping line too", () => {
        const shipping = item({ sku: "", product_id: null, variant_id: null });
        expect(taxRateForItem(shipping, ctx({ force_shipping_tax_rate: 0 }, { default_vat_rate: 23 }))).toBe(23);
    });

    it("ignores a connection rate that is not a usable number", () => {
        // An empty field in the wizard means "exempt", not "23".
        expect(taxRateForItem(item(), ctx({ force_tax_rate: 6 }, { default_vat_rate: "" }))).toBe(6);
        expect(taxRateForItem(item(), ctx({ force_tax_rate: 6 }, { default_vat_rate: 0 }))).toBe(6);
    });
});
