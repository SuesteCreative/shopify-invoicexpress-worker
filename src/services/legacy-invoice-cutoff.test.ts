/**
 * The cutoff of a legacy Shopify→InvoiceXpress integration.
 *
 * `connections` has carried `invoice_cutoff` since connection-based sources
 * arrived; the legacy Shopify row did not, so `resolveConnectionContext` handed
 * every Shopify path `null` and each one treated the merchant's whole order
 * history as Rioko's to issue. Measured on WHM (12/09/2026): five August orders
 * the merchant had already invoiced by hand into WH-25-1 (1446-1450, 7.735,30 €)
 * read as "por facturar", and a 90-day drain would have duplicated all five.
 *
 * Migration 0055 adds the column and backfills it with `created_at`.
 */

import { describe, it, expect } from "vitest";
import { legacyInvoiceCutoff } from "./connection-context";

const cfg = (o: Record<string, any>) => o as any;

describe("legacyInvoiceCutoff", () => {
  it("prefers the stored cutoff over the creation date", () => {
    expect(legacyInvoiceCutoff(cfg({
      invoice_cutoff: "2026-09-08T14:30:00.000Z",
      created_at: "2026-01-02 09:00:00",
    }))).toBe("2026-09-08T14:30:00.000Z");
  });

  it("falls back to the day the integration was set up", () => {
    expect(legacyInvoiceCutoff(cfg({ invoice_cutoff: null, created_at: "2026-09-08 14:52:25" })))
      .toBe("2026-09-08T14:52:25.000Z");
  });

  it("reads a zoneless SQLite timestamp as UTC, not as local time", () => {
    // Date.parse("2026-09-08 14:52:25") is LOCAL in V8. Inside a Worker that is
    // the same instant; anywhere else the cutoff silently moves by the offset.
    expect(legacyInvoiceCutoff(cfg({ created_at: "2026-09-08 14:52:25" })))
      .toBe(new Date("2026-09-08T14:52:25Z").toISOString());
  });

  it("leaves an already-zoned value where it is", () => {
    expect(legacyInvoiceCutoff(cfg({ created_at: "2026-09-08T15:52:25+01:00" })))
      .toBe("2026-09-08T14:52:25.000Z");
  });

  it("has no cutoff when the row carries no date at all", () => {
    expect(legacyInvoiceCutoff(cfg({ invoice_cutoff: null, created_at: null }))).toBeNull();
    expect(legacyInvoiceCutoff(null)).toBeNull();
  });

  it("refuses to invent one from a date it cannot parse", () => {
    expect(legacyInvoiceCutoff(cfg({ created_at: "not a date" }))).toBeNull();
  });
});
