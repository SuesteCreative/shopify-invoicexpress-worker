import { describe, it, expect } from "vitest";
import { IxBuilder } from "./builder";

/**
 * Soul Krave #1366, 14/09/2026: a B2C sale taxed at 23% throughout, with one
 * line taken to zero by a discount code. The zeroed line carried no tax, so the
 * document requested an exemption reason and went out stamped M99 — a fully
 * taxed sale declaring itself partly exempt.
 *
 * A discount reduces the taxable base. It does not create an exempt supply.
 */

const config: any = {
  shopify_domain: "f5fmt4-4s.myshopify.com",
  ix_account_name: "x",
  ix_api_key: "x",
  ix_exemption_reason: "M99",
  vat_included: 1,
};

const line = (over: Partial<{ unit_price: number; quantity: number; tax: number; discount: number }> = {}) => ({
  name: "Produto",
  unit_price: 10,
  quantity: 1,
  tax: 23,
  ...over,
}) as any;

describe("shouldRequestTaxExemptionReason", () => {
  const builder = new IxBuilder(config);

  it("ignores a line a discount code took to zero", () => {
    expect(builder.shouldRequestTaxExemptionReason([
      line(),
      line({ tax: 0, discount: 100 }),
    ])).toBe(false);
  });

  it("still asks for one when a line with real value sits at 0%", () => {
    expect(builder.shouldRequestTaxExemptionReason([
      line(),
      line({ tax: 0 }),
    ])).toBe(true);
  });

  it("keeps asking when every line is worth nothing, so IX decides", () => {
    expect(builder.shouldRequestTaxExemptionReason([
      line({ tax: 0, discount: 100 }),
    ])).toBe(true);
  });

  it("says nothing when the whole document is taxed", () => {
    expect(builder.shouldRequestTaxExemptionReason([line(), line()])).toBe(false);
  });
});
