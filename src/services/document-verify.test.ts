import { describe, it, expect, vi, beforeEach } from "vitest";
import { compareIntent, verifyCreatedDocument } from "./document-verify";
import { explainPlatformError, logDocumentEvent } from "./document-log";
import { reportIncident } from "./incidents";

vi.mock("./document-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./document-log")>()),
  logDocumentEvent: vi.fn(async () => {}),
}));
vi.mock("./incidents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./incidents")>()),
  reportIncident: vi.fn(async () => {}),
}));

/**
 * These two cases are not hypothetical — they are the drifts that shipped, and
 * they were both invisible because nothing ever read a document back:
 *
 *   - "Order #0": every Stripe sale documented under one reference, so the
 *     destination's idempotency check discarded the second onwards as duplicates
 *     of the first (MY VAN, 4 payments, 3.278,95 €).
 *   - lliberta 11/LL: sent with exemption code M10, InvoiceXpress stored M99.
 */

const stored = (over: Partial<{ total: number | null; reference: string | null; exemption_code: string | null }> = {}) => ({
  total: 100,
  reference: "Order #1013",
  exemption_code: "M10",
  ...over,
});

describe("compareIntent", () => {
  it("says nothing when the destination stored what we sent", () => {
    expect(compareIntent({ total: 100, reference: "Order #1013", exemptionCode: "M10" }, stored())).toEqual([]);
  });

  it("catches the exemption code lliberta lost", () => {
    const drifts = compareIntent(
      { total: 22.88, reference: "Order #1013", exemptionCode: "M10" },
      stored({ total: 22.88, exemption_code: "M99" }),
    );
    expect(drifts).toHaveLength(1);
    expect(drifts[0].field).toBe("exemption_code");
    expect(drifts[0].sent).toBe("M10");
    expect(drifts[0].stored).toBe("M99");
    // The sentence has to name both values — it is read by someone with no
    // memory of the incident.
    expect(drifts[0].meaning).toContain("M10");
    expect(drifts[0].meaning).toContain("M99");
  });

  it("catches a reference the destination rewrote", () => {
    const drifts = compareIntent(
      { reference: "Order #pi_3U3vtjJNp2FcbLOX1LzfGa73" },
      stored({ reference: "Order #0" }),
    );
    expect(drifts.map(d => d.field)).toEqual(["reference"]);
    expect(drifts[0].meaning).toMatch(/idempot/i);
  });

  it("catches a document that is not worth what was paid", () => {
    const drifts = compareIntent({ total: 258.30 }, stored({ total: 258.58 }));
    expect(drifts.map(d => d.field)).toEqual(["total"]);
  });

  it("tolerates a cent, the way the reconcile guard does", () => {
    expect(compareIntent({ total: 100 }, stored({ total: 100.01 }))).toEqual([]);
    expect(compareIntent({ total: 100 }, stored({ total: 100.02 }))).toHaveLength(1);
  });

  it("reports every field that moved, not just the first", () => {
    const drifts = compareIntent(
      { total: 50, reference: "Order #7", exemptionCode: "M10" },
      stored({ total: 60, reference: "Order #0", exemption_code: "M99" }),
    );
    expect(drifts.map(d => d.field).sort()).toEqual(["exemption_code", "reference", "total"]);
  });

  it("does not invent a drift from something we never sent", () => {
    // No intent for a field means we have nothing to hold the destination to.
    // Claiming a drift here would page about a document that is perfectly fine.
    expect(compareIntent({}, stored({ exemption_code: "M99", reference: "Order #0", total: 999 }))).toEqual([]);
  });

  it("does not compare against a destination that answered null", () => {
    // Unreadable is not the same as different — see the ix-proxy under load.
    expect(compareIntent({ total: 100, reference: "Order #1" }, { total: null, reference: null })).toEqual([]);
  });
});

describe("verifyCreatedDocument classification", () => {
  /**
   * The same mismatch means two different things depending on where the intent
   * came from. A recorded intent read back different is a `drift` — proof-grade,
   * incident-worthy. A HISTORY finding compared a document against TODAY's
   * config, and config changes over time (Bikini Books went M01→M05 this year),
   * so it is a `drift_lead`: info, no incident, confirmed by a person or aged out.
   */
  const adapterHolding = (doc: unknown) => ({ getDocument: async () => doc }) as any;
  const baseArgs = (over: Partial<import("./document-verify").VerifyArgs>) => ({
    env: {} as any,
    ctx: {} as any,
    invoiceId: "123",
    externalId: "#1013",
    intent: { acceptableExemptionCodes: ["M05"] },
    ...over,
  } as import("./document-verify").VerifyArgs);

  beforeEach(() => {
    vi.mocked(logDocumentEvent).mockClear();
    vi.mocked(reportIncident).mockClear();
  });

  it("writes a drift and raises an incident on the normal path", async () => {
    const out = await verifyCreatedDocument(baseArgs({
      adapter: adapterHolding({ total: 10, reference: "Order #1013", exemption_code: "M99" }),
    }));
    expect(out.drifts.map(d => d.field)).toEqual(["exemption_code"]);
    expect(vi.mocked(logDocumentEvent).mock.calls[0][1].event).toBe("drift");
    expect(reportIncident).toHaveBeenCalledOnce();
  });

  it("history mode writes a drift_lead and raises nothing", async () => {
    const out = await verifyCreatedDocument(baseArgs({
      historical: true,
      adapter: adapterHolding({ total: 10, reference: "Order #1013", exemption_code: "M99" }),
    }));
    expect(out.drifts).toHaveLength(1);
    const written = vi.mocked(logDocumentEvent).mock.calls[0][1];
    expect(written.event).toBe("drift_lead");
    // The summary must say out loud that this is unconfirmed — it is read by
    // someone deciding whether to bother a merchant about it.
    expect(written.summary).toMatch(/pista/i);
    expect(reportIncident).not.toHaveBeenCalled();
  });

  it("a clean history read is a plain verified — a match needs no confirming", async () => {
    await verifyCreatedDocument(baseArgs({
      historical: true,
      adapter: adapterHolding({ total: 10, reference: "Order #1013", exemption_code: "M05" }),
    }));
    expect(vi.mocked(logDocumentEvent).mock.calls[0][1].event).toBe("verified");
    expect(reportIncident).not.toHaveBeenCalled();
  });
});

describe("explainPlatformError", () => {
  it("points 'Fiscal is invalid' at the country, which is what it usually means", () => {
    const out = explainPlatformError("Fiscal is invalid", "invoicexpress");
    expect(out).toContain("PAÍS");
    expect(out).toContain("Fiscal is invalid");
  });

  it("reads a total mismatch as the guard working, not as a bug", () => {
    expect(explainPlatformError("Invoice total mismatch: paid=258.30 expected=258.58")).toMatch(/comportamento correcto/i);
  });

  it("separates a rate limit from a fault in the document", () => {
    expect(explainPlatformError("HTTP 429 Too Many Requests")).toMatch(/N[aã]o é um erro do documento/i);
  });

  it("passes an unknown error through rather than guessing at it", () => {
    const raw = "Moloni: something nobody has seen before";
    expect(explainPlatformError(raw)).toBe(raw);
  });
});
