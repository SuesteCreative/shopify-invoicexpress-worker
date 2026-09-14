/**
 * `ix_derive_exemption` on the legacy Shopify→InvoiceXpress path.
 *
 * The flag has been documented as "derive the exemption code from the buyer's
 * country and VIES" since it was added, and until now only the adapter pipeline
 * ever read it: a Shopify shop could turn it on and every export still went out
 * stamped with the shop-wide code. Measured on Soul Krave, 14/09/2026.
 *
 * What is pinned here is the whole contract of the flag:
 *   · off  ⇒ byte-for-byte the old document, which is what every other shop gets
 *   · on   ⇒ an export named as one (M05), a domestic sale left alone
 *   · never on a fully taxed document, whatever the flag says
 */

import { describe, it, expect } from "vitest";
import { IxBuilder } from "./builder";

const shopConfig = (extra: any = {}): any => ({
  user_id: "u1",
  shopify_domain: "shop.myshopify.com",
  ix_document_type: "invoice_receipt",
  vat_included: 1,
  oss_enabled: 1,
  b2b_reverse_charge: 0,
  pos_mode: 0,
  auto_finalize: 0,
  ix_exemption_reason: "M99",
  ix_b2b_exemption_reason: "M16",
  ix_stamp_exemption_note: 0,
  ix_derive_exemption: 0,
  force_tax_rate: null,
  force_shipping_tax_rate: null,
  ...extra,
});

/** One line, at whatever rate the shop collected, shipped where we say. */
const order = (taxRate: number, shipTo: string): any => ({
  order: {
    id: 4242,
    order_number: 1366,
    created_at: "2026-09-09T10:00:00Z",
    note: null,
    note_attributes: [],
    total: Math.round(100 * (1 + taxRate / 100) * 100) / 100,
    customer: { name: "Ana Costa", email: "ana@example.com" },
    billing_address: { name: "Ana Costa", country_code: "PT", country: "Portugal", company: "" },
    shipping_address: { country_code: shipTo },
    items: [{
      id: 1,
      quantity: 1,
      unit_price: 100,
      tax: { name: "VAT", value: taxRate, unit_amount: taxRate === 0 ? 0 : 1 },
      discount: { name: "", percent: 0 },
      title: "Creme",
      variant_title: null,
      sku: "CRM-1",
    }],
    global_discount: { name: "", percent: 0, amount: 0 },
  },
});

const build = (config: any, o: any) =>
  new IxBuilder(config).createInvoiceFromNormalizedOrderAsync(o);

describe("ix_derive_exemption on the Shopify path", () => {
  it("names an export as an export instead of stamping the shop's generic code", async () => {
    const res: any = await build(shopConfig({ ix_derive_exemption: 1 }), order(0, "AU"));
    expect(res.status).toBe("ready");
    expect(res.invoice.tax_exemption_reason).toBe("M05");
  });

  it("leaves the shop-wide code alone when the shop did not ask", async () => {
    const res: any = await build(shopConfig(), order(0, "AU"));
    expect(res.invoice.tax_exemption_reason).toBe("M99");
  });

  it("does not touch a domestic exempt sale, whose reason is the shop's own", async () => {
    const res: any = await build(shopConfig({ ix_derive_exemption: 1 }), order(0, "PT"));
    expect(res.invoice.tax_exemption_reason).toBe("M99");
  });

  it("stamps nothing on a fully taxed sale, flag or no flag", async () => {
    const on: any = await build(shopConfig({ ix_derive_exemption: 1 }), order(23, "AU"));
    const off: any = await build(shopConfig(), order(23, "AU"));
    expect(on.invoice.tax_exemption_reason).toBeUndefined();
    expect(off.invoice.tax_exemption_reason).toBeUndefined();
  });

  it("never moves money: same lines and totals either way", async () => {
    const on: any = await build(shopConfig({ ix_derive_exemption: 1 }), order(0, "AU"));
    const off: any = await build(shopConfig(), order(0, "AU"));
    expect(on.invoice.items).toEqual(off.invoice.items);
  });
});
