/**
 * What a line is called on the document.
 *
 * "No product id" meant shipping, which was true for the only source that has
 * shipping: Shopify puts delivery in `shipping_lines`, and those carry no ids.
 * Stripe, EuPago and Lodgify have no shipping at all and carry `product_id: 0`
 * on the one thing they sell — so every line of every document they produced
 * was named "Portes de envio — <what was actually sold>". Measured live on
 * 2026-09-08: a Wim Hof Method course of 19,95 AUD invoiced as
 * "Portes de envio — Crash Course".
 *
 * The guess is only ever true of Shopify — and a Shopify order never reaches
 * this function, because it carries its raw payload and takes the raw path.
 *
 * Two things rode on the same guess, which is why this is not cosmetic: the
 * description is what art. 36.º n.º 5 CIVA requires the document to state, and
 * a line believed to be shipping takes `force_shipping_tax_rate` instead of the
 * product rate.
 */

import { describe, it, expect } from "vitest";
import { IxBuilder } from "./builder";

const cfg = (over: Record<string, any> = {}): any => ({
  ix_document_type: "invoice_receipt",
  vat_included: 0,
  ...over,
});

const item = (over: Record<string, any> = {}): any => ({
  id: 1,
  product_id: 0,
  variant_id: 0,
  quantity: 1,
  unit_price: 19.95,
  unit_price_calculated: 19.95,
  subtotal_calculated: 19.95,
  tax: { name: "VAT", value: 0, unit_amount: 0 },
  discount: { name: "", percent: 0 },
  title: "Crash Course",
  variant_title: null,
  sku: "pi_3UBPkmLXiybx6Vcz0gyjU67A",
  fulfilled: true,
  fulfilled_quantity: 1,
  fulfillment_status: "fulfilled",
  ...over,
});

describe("shipping line naming", () => {
  it("names a Stripe line after what was sold, not after delivery", () => {
    const [line] = new IxBuilder(cfg()).buildInvoiceItems([item()]);

    expect(line.name).toBe("Crash Course");
    expect(line.name).not.toContain("Portes de envio");
  });

  it("still calls a Shopify shipping line what it is", () => {
    // The credit-note path asks for the inference when the order has a raw
    // Shopify payload behind it, which is the only place shipping exists.
    const [line] = new IxBuilder(cfg()).buildInvoiceItems(
      [item({ title: "Standard" })],
      { shippingFromIds: true },
    );

    expect(line.name).toBe("Portes de envio — Standard");
  });

  it("takes the product rate, not the shipping rate, once it knows", () => {
    // A shop with both forced rates configured: the line must not be taxed as
    // delivery just because it carries no product id.
    const config = cfg({ force_tax_rate: 23, force_shipping_tax_rate: 6 });

    const [product] = new IxBuilder(config).buildInvoiceItems([item()]);
    const [shipping] = new IxBuilder(config).buildInvoiceItems([item()], { shippingFromIds: true });

    expect(product.tax).toBe(23);
    expect(shipping.tax).toBe(6);
  });

  it("keeps the SKU as the line description when the line is goods", () => {
    // Shipping lines deliberately carry no description; a product line carries
    // its SKU, which for a Stripe sale is the PaymentIntent id.
    const [line] = new IxBuilder(cfg()).buildInvoiceItems([item()]);

    expect(line.description).toBe("SKU: pi_3UBPkmLXiybx6Vcz0gyjU67A");
  });
});
