import { describe, it, expect } from "vitest";
import { scoreHeuristicMatch } from "./reconciliation-score";

// The pair that exposed this: WHM's pi_3UFgs8LXiybx6Vcz16fo3Ccz, 187,60 USD
// paid, issued as a 162,41 € InvoiceXpress document at the ECB rate for the day.
const PAID_USD = { amount: 187.6, currency: "USD", date: "2026-09-14T20:55:00Z", customerName: "Robin McLaughlin" };
const DOC_EUR = { amount: 162.41, date: "2026-09-14", clientName: "Robin McLaughlin" };

describe("scoreHeuristicMatch", () => {
  it("scores the amount and names its currency when both sides agree", () => {
    const { score, reasons } = scoreHeuristicMatch(
      { amount: 187.6, currency: "USD", date: "2026-09-14T20:55:00Z", customerName: "Robin McLaughlin" },
      { amount: 187.6, currency: "USD", date: "2026-09-14", clientName: "Robin McLaughlin" },
    );
    expect(score).toBeGreaterThanOrEqual(40);
    expect(reasons).toContain("valor $187.60");
    expect(reasons.join(" ")).not.toContain("€");
  });

  it("spells out a currency with no symbol of its own rather than guessing one", () => {
    const { reasons } = scoreHeuristicMatch(
      { amount: 449, currency: "CAD", date: "2026-09-14T18:42:00Z" },
      { amount: 449, currency: "CAD", date: "2026-09-14" },
    );
    // "$449.00" for Canadian dollars would be worse than no symbol at all.
    expect(reasons).toContain("valor 449.00 CAD");
  });

  it("defaults both sides to euros and keeps the euro symbol", () => {
    const { reasons } = scoreHeuristicMatch(
      { amount: 99.9, date: "2026-09-14T10:00:00Z" },
      { amount: 99.9, date: "2026-09-14" },
    );
    expect(reasons).toContain("valor €99.90");
  });

  it("abstains on the amount when the sale and the document are in different currencies", () => {
    const { score, reasons } = scoreHeuristicMatch(PAID_USD, DOC_EUR);
    // No amount points either way — and, crucially, no claim that the values differ.
    expect(reasons).toContain("valor em USD, documento em EUR");
    expect(reasons.some(r => r.startsWith("valor €") || r === "valor próximo")).toBe(false);
    // Date + name still carry it above the 30-point candidate threshold, which
    // is the whole point: before this, a correct foreign pair scored below it.
    expect(score).toBeGreaterThanOrEqual(30);
  });

  it("does not let a currency difference rescue a wrong customer", () => {
    const { score } = scoreHeuristicMatch(PAID_USD, { ...DOC_EUR, clientName: "Someone Else Entirely" });
    expect(score).toBe(0);
  });
});
