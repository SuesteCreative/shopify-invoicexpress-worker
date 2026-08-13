import { describe, it, expect } from "vitest";
import { classifyRecordForBilling } from "./admin-connection";
import type { SourceRecordRef } from "../adapters/recovery/types";

function record(over: Partial<SourceRecordRef> = {}): SourceRecordRef {
  return {
    externalId: "pi_1",
    orderNumber: null,
    label: "pi_1",
    paidTotal: 42,
    paidAt: "2026-08-01T10:00:00Z",
    replayBody: {},
    blocker: null,
    ...over,
  };
}

const CUTOFF = Date.parse("2026-07-01T00:00:00Z");

describe("classifyRecordForBilling", () => {
  it("bills a settled, unresolved, post-cutoff sale", () => {
    expect(classifyRecordForBilling(record(), { dryRun: false, resolved: new Set(), cutoff: CUTOFF }))
      .toEqual({ action: "bill" });
  });

  it("refuses a record the source flagged", () => {
    // A refunded or unpaid order must never be invoiced by a bulk run.
    const d = classifyRecordForBilling(
      record({ blocker: "não está pago (financial_status=refunded)" }),
      { dryRun: false, resolved: new Set(), cutoff: null },
    );
    expect(d).toEqual({ action: "skip", message: "não está pago (financial_status=refunded)" });
  });

  it("the source's own blocker outranks everything else", () => {
    // Even in a dry run: the preview an operator approves must not show a sale
    // being billed that the real run would refuse.
    const d = classifyRecordForBilling(
      record({ blocker: "cancelada" }),
      { dryRun: true, resolved: new Set(), cutoff: null },
    );
    expect(d.action).toBe("skip");
  });

  it("skips anything already resolved", () => {
    // "Resolved" is broader than "invoiced": operator hand-matches and
    // NOT_NEEDED decisions live in the same set, and resurrecting those turns a
    // safety backstop into a recurring bug.
    const d = classifyRecordForBilling(
      record(),
      { dryRun: false, resolved: new Set(["pi_1"]), cutoff: null },
    );
    expect(d).toEqual({ action: "skip", message: "Já facturada ou resolvida manualmente" });
  });

  it("skips sales from before the connection's invoice_cutoff", () => {
    const d = classifyRecordForBilling(
      record({ paidAt: "2026-06-15T10:00:00Z" }),
      { dryRun: false, resolved: new Set(), cutoff: CUTOFF },
    );
    expect(d.action).toBe("skip");
    expect(d).toHaveProperty("message", "Anterior ao início da facturação (invoice_cutoff)");
  });

  it("bills a sale exactly on the cutoff", () => {
    // The cutoff is the moment invoicing became ours, not the moment after.
    const d = classifyRecordForBilling(
      record({ paidAt: "2026-07-01T00:00:00Z" }),
      { dryRun: false, resolved: new Set(), cutoff: CUTOFF },
    );
    expect(d).toEqual({ action: "bill" });
  });

  it("bills when the source cannot say when the sale was paid", () => {
    // No paidAt means the cutoff cannot be applied. Skipping on an unknown would
    // silently drop real sales; the operator picked the window deliberately.
    const d = classifyRecordForBilling(
      record({ paidAt: null }),
      { dryRun: false, resolved: new Set(), cutoff: CUTOFF },
    );
    expect(d).toEqual({ action: "bill" });
  });

  it("previews instead of billing in a dry run", () => {
    const d = classifyRecordForBilling(record(), { dryRun: true, resolved: new Set(), cutoff: null });
    expect(d).toEqual({ action: "dry_run", message: "Seria facturada (42.00 €)" });
  });

  it("still skips resolved records in a dry run, so the preview matches the run", () => {
    const d = classifyRecordForBilling(
      record(),
      { dryRun: true, resolved: new Set(["pi_1"]), cutoff: null },
    );
    expect(d.action).toBe("skip");
  });
});
