import { describe, it, expect } from "vitest";
import { possibleExemptionCodes } from "./fiscal-classification";

/**
 * What the nightly verification will accept on a document older than 90 days.
 *
 * `document_events` keeps a `built` intent for 90 routine-tier days. Past that
 * the exact code we sent is gone, and the sweep can only ask whether the stored
 * code is one this connection could have produced. Get the set too narrow and
 * every export reports a drift that is not one; too wide and the check stops
 * claiming anything at all.
 */
describe("possibleExemptionCodes", () => {
  const BASE = { ix_exemption_reason: "M01", ix_b2b_exemption_reason: "M16" };

  it("is just the connection's own two codes when it names no regime", () => {
    // The overwhelming majority of connections. Widening the set for them would
    // blunt the only claim this check makes.
    expect(possibleExemptionCodes(BASE, {})).toEqual(["M01", "M16"]);
    expect(possibleExemptionCodes(BASE, undefined)).toEqual(["M01", "M16"]);
  });

  it("accepts the export article once the connection names the regime per sale", () => {
    // Without this, every export older than 90 days on a classifying connection
    // is reported as a drift — the code is M05 and the old set had no M05 in it.
    const out = possibleExemptionCodes({ ...BASE, ix_derive_exemption: 1 }, {});
    expect(out).toContain("M05");
    expect(out).toContain("M16");
  });

  it("accepts the same set for a reverse-charge registration", () => {
    const out = possibleExemptionCodes(BASE, { b2b_reverse_charge_pipeline: true });
    expect(out).toContain("M05");
    expect(out).toContain("M16");
  });

  it("accepts the export code the merchant chose for themselves", () => {
    const out = possibleExemptionCodes({ ...BASE, ix_derive_exemption: 1 }, { oss_export_exemption_code: "M99" });
    expect(out).toContain("M99");
  });

  it("accepts M40, which the rate engine stamps when nothing named the sale", () => {
    const out = possibleExemptionCodes({ ...BASE, ix_derive_exemption: 1 }, { oss_engine: 1 });
    expect(out).toContain("M40");
  });

  it("never accepts M40 on a connection that decides nothing", () => {
    // The registration is what makes the wider set legitimate. A connection with
    // neither must not quietly inherit the permission.
    expect(possibleExemptionCodes(BASE, { oss_engine: 1 })).toEqual(["M01", "M16"]);
  });

  it("returns no empties and no duplicates", () => {
    // The set is compared against a stored value; an empty string in it would
    // accept a document that carries no code at all.
    const out = possibleExemptionCodes(
      { ix_exemption_reason: "M05", ix_b2b_exemption_reason: null, ix_derive_exemption: 1 },
      { oss_export_exemption_code: "  " },
    );
    expect(out).not.toContain("");
    expect(new Set(out).size).toBe(out.length);
  });
});
