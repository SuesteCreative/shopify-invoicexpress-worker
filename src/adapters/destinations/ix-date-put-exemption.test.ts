import { describe, it, expect } from "vitest";
import { buildIxDatePutBody } from "./ix-finalize";
import { resolveExemptionCode } from "../../ix/exemption";

/**
 * The M99 regression, as a test.
 *
 * lliberta is an art. 53 shop: every line is 0% and every document must name
 * M10 as the reason. Document 11/LL was CREATED carrying M10 — the worker's own
 * log holds the InvoiceXpress response with `tax_exemption":"M10"` — and today
 * InvoiceXpress stores M99 on it, while the document's observations still print
 * the M10 legal text.
 *
 * Both halves of that are explained here. The date PUT replaces the document; it
 * sends observations verbatim (so the sentence survived) and it dropped
 * `tax_exemption_reason` (so the code did not), because the draft read back with
 * `tax_exemption: ""` and `??` keeps an empty string. IX then applied its own
 * default instead of refusing.
 *
 * Its sibling 10/LL was finalized on its own date, never reached the PUT, and
 * still holds M10 — which is the control case for all of this.
 */

// One exempt line, and a doc.total that agrees with it, so the rebuild's
// money guard passes and the exemption logic is what is under test.
const exemptDoc = (over: Record<string, unknown> = {}) => ({
  status: "draft",
  date: "10/08/2026",
  total: 22.88,
  reference: "Order #1013",
  observations: "IVA - regime especial de isenção (art. 53.º do CIVA)",
  items: [{ quantity: 1, name: "Livro", unit_price: 22.88, tax: { id: 4, name: "Isento", value: 0 } }],
  ...over,
});

const ctx = (exemptionReason: string | null) => ({
  accountTaxes: new Map<number, { name: string; value: number }>(),
  exemptionReason,
});

describe("buildIxDatePutBody and the exemption code", () => {
  it("keeps the shop's code when IX reads the draft back with an empty exemption", () => {
    // The exact production shape. Before the fix this produced a body with no
    // tax_exemption_reason at all, and IX stamped M99.
    const body = buildIxDatePutBody(exemptDoc({ tax_exemption: "" }), "invoice", "2026-08-12", "obs", ctx("M10"));
    expect(body.data.tax_exemption_reason).toBe("M10");
  });

  it("treats a whitespace-only code as no code", () => {
    const body = buildIxDatePutBody(exemptDoc({ tax_exemption: "   " }), "invoice", "2026-08-12", "obs", ctx("M10"));
    expect(body.data.tax_exemption_reason).toBe("M10");
  });

  it("prefers the code the document already carries over the shop's current one", () => {
    // A document issued under a code the shop has since changed away from must
    // keep its own — Bikini Books went M01 to M05 mid-year, and moving a July
    // document's date must not restate it as M05.
    const body = buildIxDatePutBody(exemptDoc({ tax_exemption: "M01" }), "invoice", "2026-08-12", "obs", ctx("M05"));
    expect(body.data.tax_exemption_reason).toBe("M01");
  });

  it("refuses to rewrite an exempt document when no code is known anywhere", () => {
    // Never silently: IX does not reject this payload, it stamps M99, so the
    // only safe answer is to leave the draft alone.
    expect(() => buildIxDatePutBody(exemptDoc({ tax_exemption: "" }), "invoice", "2026-08-12", "obs", ctx(null)))
      .toThrow(/M99/);
  });

  it("sends the observations verbatim — the half that always survived", () => {
    const body = buildIxDatePutBody(exemptDoc({ tax_exemption: "" }), "invoice", "2026-08-12", "nota legal M10", ctx("M10"));
    expect(body.data.observations).toBe("nota legal M10");
  });

  it("asks for no exemption on a fully taxed document, and does not refuse it", () => {
    const taxed = exemptDoc({
      tax_exemption: "",
      total: 24.25,
      items: [{ quantity: 1, name: "Artigo", unit_price: 22.88, tax: { id: 1, name: "IVA6", value: 6 } }],
    });
    const body = buildIxDatePutBody(taxed, "invoice", "2026-08-12", "obs", ctx(null));
    expect(body.data.tax_exemption_reason).toBeUndefined();
  });

  it("never lends the shop's configured code to a document that is not exempt", () => {
    // The mirror-image mistake: a 6% document must not be handed an exemption
    // reason just because the shop has one configured.
    const taxed = exemptDoc({
      total: 24.25,
      items: [{ quantity: 1, name: "Artigo", unit_price: 22.88, tax: { id: 1, name: "IVA6", value: 6 } }],
    });
    const body = buildIxDatePutBody(taxed, "invoice", "2026-08-12", "obs", ctx("M99"));
    expect(body.data.tax_exemption_reason).toBeUndefined();
  });
});

describe("resolveExemptionCode", () => {
  it("reads an empty stored code as absent, which `??` does not", () => {
    expect(resolveExemptionCode("", "M10")).toBe("M10");
    // The spelling that caused the drift, kept here so the difference is not
    // something anyone has to take on trust.
    const storedEmpty: string | null = "";
    expect(storedEmpty ?? "M10").toBe("");
  });

  it("returns null when neither side knows a code", () => {
    expect(resolveExemptionCode("", null)).toBeNull();
    expect(resolveExemptionCode(undefined, "  ")).toBeNull();
  });

  it("ignores a non-string stored value rather than stringifying it", () => {
    expect(resolveExemptionCode(null, "M05")).toBe("M05");
    expect(resolveExemptionCode(0, "M05")).toBe("M05");
  });
});
