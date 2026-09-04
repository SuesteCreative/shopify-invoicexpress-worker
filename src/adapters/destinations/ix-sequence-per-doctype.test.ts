/**
 * A named InvoiceXpress series is a family, not a number.
 *
 * `sequences.json` answers one row per series, and inside it a separate id per
 * document type. The row's top-level `id` is the INVOICE id, and we were
 * sending it for every document type. Measured against the IX sandbox on
 * 2026-09-04, series INVOICEXPRESSDEMO (`id: 47734`,
 * `current_invoice_receipt_sequence_id: 47736`):
 *
 *   POST /v2/documents type=invoice_receipt sequence_id=47734
 *     → HTTP 400 "A série não corresponde ao tipo de documento"
 *   POST /v2/documents type=invoice_receipt sequence_id=47736
 *     → HTTP 200
 *
 * So a connection issuing invoice-receipts into a named series never created
 * the document at all — the sale stayed unbilled with a 400 nobody read as a
 * configuration problem. A merchant filing one series per destination country
 * would have hit it on every single sale.
 */

import { describe, it, expect } from "vitest";
import { pickSequenceId, type IxSequenceRow } from "./ix-destination";

/** The sandbox row, verbatim in the fields that matter. */
const demoSeries: IxSequenceRow = {
  id: 47734,
  serie: "INVOICEXPRESSDEMO",
  current_invoice_sequence_id: 47734,
  current_simplified_invoice_sequence_id: 47735,
  current_invoice_receipt_sequence_id: 47736,
  current_receipt_sequence_id: 47737,
  current_debit_note_sequence_id: 47738,
  current_credit_note_sequence_id: 47739,
};

describe("pickSequenceId", () => {
  it("sends the invoice-receipt id for an invoice-receipt, not the invoice one", () => {
    expect(pickSequenceId(demoSeries, "invoice_receipt")).toBe(47736);
  });

  it("sends the invoice id for an invoice", () => {
    expect(pickSequenceId(demoSeries, "invoice")).toBe(47734);
  });

  it("knows the credit-note id, so a refund can be credited in the sale's own series", () => {
    expect(pickSequenceId(demoSeries, "credit_note")).toBe(47739);
  });

  it("knows the simplified-invoice id", () => {
    expect(pickSequenceId(demoSeries, "simplified_invoice")).toBe(47735);
  });

  it("falls back to the row id when the account exposes no per-type ids", () => {
    // An older or leaner sequences payload. This is the pre-fix behaviour, and
    // it is right for a plain invoice — which is why the bug stayed hidden.
    expect(pickSequenceId({ id: 900, serie: "FR26" }, "invoice_receipt")).toBe(900);
  });

  it("reports nothing rather than sending a zero the API would reject", () => {
    expect(pickSequenceId({ id: 0, serie: "X" }, "invoice")).toBeNull();
  });

  it("ignores a per-type id of zero — an unconfigured type, not a real series", () => {
    expect(pickSequenceId({ id: 47734, serie: "X", current_credit_note_sequence_id: 0 }, "credit_note"))
      .toBe(47734);
  });
});
