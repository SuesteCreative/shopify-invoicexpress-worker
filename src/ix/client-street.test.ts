import { describe, it, expect } from "vitest";
import { IxBuilder } from "./builder";

// `pickInvoiceAddress` spreads `customer.address` last, and every Stripe shape
// sets that to an all-empty address — so a street the payment carried was
// overwritten with "". The zip already worked around it and the city never went
// through the merge at all; the street was the field left behind. Measured on
// Bestisafil (14/09/2026): document 270275892 reached InvoiceXpress with
// "1269-046 Lisboa" and no street, while the charge held
// "Av. da Liberdade nº 110".
const base = {
  user_id: "u1", ix_document_type: "invoice_receipt",
  vat_included: 1, oss_enabled: 0, b2b_reverse_charge: 0, pos_mode: 0, auto_finalize: 0,
};

/** What a Stripe-sourced order looks like: a filled billing address, and a
 *  customer whose own address is present but entirely blank. */
const stripeShapedOrder = (): any => ({
  order: {
    id: 1,
    order_number: 0,
    currency: "EUR",
    total_price: "135.78",
    customer: {
      name: "Perímetros Poéticos, Lda",
      default_address: { address1: "", city: "", zip: "", country_code: "", country: "" },
      address: { address1: "", city: "", zip: "", country_code: "", country: "" },
    },
    billing_address: {
      name: "Perímetros Poéticos, Lda",
      address1: "Av. da Liberdade nº 110",
      city: "Lisboa",
      zip: "1269-046",
      country_code: "PT",
      country: "PT",
    },
  },
});

describe("the street on the InvoiceXpress client", () => {
  it("keeps the street a blank customer address used to erase", () => {
    const c = new IxBuilder({ ...base, stripe_address_from_charge: 1 } as any)
      .buildInvoiceClient(stripeShapedOrder());

    expect(c.address).toBe("Av. da Liberdade nº 110");
    // The two that already survived must keep surviving.
    expect(c.postal_code).toBe("1269-046");
    expect(c.city).toBe("Lisboa");
  });

  // Shopify reads the same builder, and there `customer.address` is the buyer's
  // saved address: letting it win is the precedence that shop has always had.
  it("leaves the merge alone for a connection that did not declare the flag", () => {
    const c = new IxBuilder(base as any).buildInvoiceClient(stripeShapedOrder());

    expect(c.address).toBe("");
  });

  // The flag changes which layer is asked first, not what a real value means: a
  // customer address that actually says something still wins on Shopify.
  it("never invents a street when neither layer has one", () => {
    const o = stripeShapedOrder();
    o.order.billing_address.address1 = "";
    const c = new IxBuilder({ ...base, stripe_address_from_charge: 1 } as any).buildInvoiceClient(o);

    expect(c.address).toBeUndefined();
  });
});
