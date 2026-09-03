import { describe, it, expect } from "vitest";
import { receiptDelta } from "./reconcile";

/**
 * The arithmetic behind a Recibo.
 *
 * Every case here is a way to receipt the wrong amount against a closed fiscal
 * document, which is undone only by voiding the receipt: paying twice for the
 * same deposit, settling money the guest never sent, or exceeding the invoice
 * and having Moloni refuse mid-run.
 */
describe("receiptDelta", () => {
  it("settles the deposit on the first pass", () => {
    expect(receiptDelta({ collected: 334.5, invoiceTotal: 669, alreadySettled: 0 })).toBe(334.5);
  });

  it("settles nothing on the second pass", () => {
    expect(receiptDelta({ collected: 334.5, invoiceTotal: 669, alreadySettled: 334.5 })).toBe(0);
  });

  it("settles only the new money when the balance lands", () => {
    expect(receiptDelta({ collected: 669, invoiceTotal: 669, alreadySettled: 334.5 })).toBe(334.5);
  });

  it("never exceeds the document, whatever the source says came in", () => {
    // An overpayment is a conversation with the guest, not a bigger Recibo.
    expect(receiptDelta({ collected: 800, invoiceTotal: 669, alreadySettled: 0 })).toBe(669);
    expect(receiptDelta({ collected: 800, invoiceTotal: 669, alreadySettled: 669 })).toBe(0);
  });

  it("ignores a cent of rounding rather than issuing a receipt for it", () => {
    expect(receiptDelta({ collected: 669.005, invoiceTotal: 669, alreadySettled: 669 })).toBe(0);
  });

  it("holds when nothing has been received", () => {
    expect(receiptDelta({ collected: 0, invoiceTotal: 669, alreadySettled: 0 })).toBe(0);
  });

  it("treats unusable numbers as nothing received", () => {
    expect(receiptDelta({ collected: NaN, invoiceTotal: 669, alreadySettled: 0 })).toBe(0);
    expect(receiptDelta({ collected: 334.5, invoiceTotal: NaN, alreadySettled: 0 })).toBe(0);
  });
});
