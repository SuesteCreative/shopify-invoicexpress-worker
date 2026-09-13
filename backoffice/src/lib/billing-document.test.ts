import { describe, it, expect } from "vitest";
import { canHaveKaptaDocument } from "./billing-document";

describe("which billing events a Kapta document can still arrive for", () => {
    it("a paid invoice and a refund, with money on them", () => {
        expect(canHaveKaptaDocument({ type: "invoice.paid", status: "paid", amount_cents: 750 })).toBe(true);
        expect(canHaveKaptaDocument({ type: "charge.refunded", status: "refunded", amount_cents: 750 })).toBe(true);
    });

    it("never a failed attempt, even one that asked for money", () => {
        expect(canHaveKaptaDocument({ type: "invoice.payment_failed", status: "open", amount_cents: 750 })).toBe(false);
        expect(canHaveKaptaDocument({ type: "invoice.payment_failed", status: "failed", amount_cents: 750 })).toBe(false);
    });

    it("never a payment of nothing", () => {
        expect(canHaveKaptaDocument({ type: "invoice.paid", status: "paid", amount_cents: 0 })).toBe(false);
        expect(canHaveKaptaDocument({ type: "charge.refunded", status: "refunded", amount_cents: null })).toBe(false);
    });
});
