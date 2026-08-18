import { describe, it, expect } from "vitest";
import { refundHasNothingToCredit } from "./refunds-create";

/**
 * Angel #4814: 234,20 € sitting unpaid on Multibanco, a 0,00 € return logged
 * against it, and a critical "Tentativas esgotadas" alert about a credit note
 * that could never have existed. `only_invoice_when_paid` had correctly held
 * the order at orders/created, so there was no invoice — and the refund handler
 * read that absence as a failure worth six retries and a page.
 *
 * The rule has to stay narrow in both directions: silence the case that cannot
 * be done, and keep retrying the one that is merely early.
 */

describe("a refund with no invoice behind it", () => {
  it("is nothing to do when the order never reached paid", () => {
    for (const status of ["pending", "authorized", "voided", "expired", "unpaid"]) {
      expect(refundHasNothingToCredit(status, 1)).toBe(true);
    }
  });

  it("still retries for a paid order — that is the invoice-not-written-yet race", () => {
    expect(refundHasNothingToCredit("paid", 1)).toBe(false);
  });

  it("still retries once money has already gone back", () => {
    // A real credit note is owed here; the invoice simply is not findable yet.
    expect(refundHasNothingToCredit("refunded", 1)).toBe(false);
    expect(refundHasNothingToCredit("partially_refunded", 1)).toBe(false);
  });

  it("does not guess when Shopify told us nothing", () => {
    // The raw order fetch can fail; unknown is not the same as unpaid, and
    // swallowing a refund on that basis would lose a real credit note.
    expect(refundHasNothingToCredit("", 1)).toBe(false);
    expect(refundHasNothingToCredit(null, 1)).toBe(false);
    expect(refundHasNothingToCredit(undefined, 1)).toBe(false);
    expect(refundHasNothingToCredit("   ", 1)).toBe(false);
  });

  it("stays out of the way on shops that invoice before payment", () => {
    // Without the flag an unpaid order IS invoiced at orders/created, so a
    // missing document is a genuine fault and must keep its retries.
    expect(refundHasNothingToCredit("pending", 0)).toBe(false);
    expect(refundHasNothingToCredit("pending", null)).toBe(false);
  });
});
