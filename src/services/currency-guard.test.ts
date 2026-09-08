/**
 * Which destinations may see a sale that was not paid in euros.
 *
 * Measured in production on 2026-09-08: re-emitting a 19,95 AUD Wim Hof Method
 * payment through the worker answered
 *
 *   stripe/created · "Skipped: currency AUD not supported (EUR only)"
 *
 * and raised a critical incident. The sale was never invoiced — which is what
 * this guard was for while InvoiceXpress had no way to convert, and became the
 * wrong answer the moment it did. 33 of that merchant's last 89 payments are
 * not in euros.
 */

import { describe, it, expect } from "vitest";
import { destinationHandlesForeignCurrency } from "./currency-guard";

describe("destinationHandlesForeignCurrency", () => {
  it("lets InvoiceXpress through, because it now restates the sale in euros", () => {
    expect(destinationHandlesForeignCurrency("invoicexpress")).toBe(true);
  });

  it("lets Moloni through, because it issues in the currency the buyer paid", () => {
    expect(destinationHandlesForeignCurrency("moloni")).toBe(true);
  });

  it("still stops Vendus, which has no FX path at all", () => {
    // Better an unbilled order someone can see than a document valued in the
    // wrong currency, which is a fiscal record that cannot be taken back.
    expect(destinationHandlesForeignCurrency("vendus")).toBe(false);
  });

  it("stops anything it has not been told about", () => {
    expect(destinationHandlesForeignCurrency("something_new")).toBe(false);
  });
});
