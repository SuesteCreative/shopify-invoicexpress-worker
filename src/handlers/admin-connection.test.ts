import { describe, it, expect } from "vitest";
import { classifyRecordForBilling, orderByTransactionDate } from "./admin-connection";
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

  it("bills a pre-cutoff sale when the caller passes no cutoff (backfill ignore_cutoff)", () => {
    // How a deliberate history backfill reaches sales the automatic paths must
    // never touch: the caller drops the cutoff for ONE bounded, dry-runnable
    // command, rather than moving `invoice_cutoff` — which would hand the same
    // history to the next unattended run, minutes later, with nobody watching.
    // Every other guard still applies; only the date test is lifted.
    const d = classifyRecordForBilling(
      record({ paidAt: "2023-04-02T10:00:00Z" }),
      { dryRun: false, resolved: new Set(), cutoff: null },
    );
    expect(d).toEqual({ action: "bill" });
  });

  it("ignoring the cutoff does not resurrect resolved or blocked records", () => {
    const resolvedRow = classifyRecordForBilling(
      record({ paidAt: "2023-04-02T10:00:00Z" }),
      { dryRun: false, resolved: new Set(["pi_1"]), cutoff: null },
    );
    expect(resolvedRow.action).toBe("skip");

    const blockedRow = classifyRecordForBilling(
      record({ paidAt: "2023-04-02T10:00:00Z", blocker: "cancelada" }),
      { dryRun: false, resolved: new Set(), cutoff: null },
    );
    expect(blockedRow.action).toBe("skip");
  });
});

describe("orderByTransactionDate", () => {
  const row = (id: string, created_at: string | null) => ({ id, created_at, invoice_id: id });

  it("certifies the oldest sale first, whatever order the rows were stored in", () => {
    // The batch that exposed this: a Stripe backfill inserts newest-first, so
    // the newest draft closed first and lifted the series floor over the other
    // 21, which all died on "date >= 2026-08-12".
    const rows = [
      row("pi_new", "2026-08-17T09:00:00Z"),
      row("pi_old", "2026-08-17T09:00:01Z"),
      row("pi_mid", "2026-08-17T09:00:02Z"),
    ];
    const paidAt: Record<string, string> = {
      pi_new: "2026-08-12T10:00:00Z",
      pi_old: "2026-07-30T10:00:00Z",
      pi_mid: "2026-08-04T10:00:00Z",
    };
    expect(orderByTransactionDate(rows, (id) => paidAt[id] ?? null).map((r) => r.id))
      .toEqual(["pi_old", "pi_mid", "pi_new"]);
  });

  it("falls back to the stored row date when the source has no paid_at", () => {
    const rows = [row("b", "2026-08-10T00:00:00Z"), row("a", "2026-08-01T00:00:00Z")];
    expect(orderByTransactionDate(rows, () => null).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("puts rows with no date at all last, so they cannot set the series floor", () => {
    const rows = [row("unknown", null), row("dated", "2026-08-01T00:00:00Z")];
    expect(orderByTransactionDate(rows, () => null).map((r) => r.id)).toEqual(["dated", "unknown"]);
  });

  it("compares ISO timestamps and D1 dates by day, not by string shape", () => {
    // paid_at is "2026-08-01T10:00:00Z" and created_at is "2026-08-01 09:00:00":
    // compared whole, 'T' > ' ' would order a same-day pair by which field it
    // came from rather than by date.
    const rows = [row("d1", "2026-08-02 09:00:00"), row("iso", "2026-08-01T10:00:00Z")];
    expect(orderByTransactionDate(rows, (id) => (id === "iso" ? "2026-08-01T10:00:00Z" : null)).map((r) => r.id))
      .toEqual(["iso", "d1"]);
  });

  it("leaves the input array untouched", () => {
    const rows = [row("b", "2026-08-10T00:00:00Z"), row("a", "2026-08-01T00:00:00Z")];
    orderByTransactionDate(rows, () => null);
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
  });
});
