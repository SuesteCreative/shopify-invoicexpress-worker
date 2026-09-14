import { describe, it, expect } from "vitest";
import { IxBuilder } from "./builder";

// A nine-digit number that passes the PT checksum is not the same thing as a
// tax number somebody meant to give. Measured 14/09/2026 against this builder:
// a Stripe metadata entry `stora_id` holding nine digits is stamped as the
// buyer's contribuinte — and so is one that FAILS the checksum, through the
// non-PT branch. Bestisafil's source writes numeric metadata into exactly that
// place, so the day an internal id grows to nine digits it becomes a tax number
// on a fiscal document.
const cfg: any = {
  user_id: "u1", ix_document_type: "invoice_receipt",
  vat_included: 1, oss_enabled: 0, b2b_reverse_charge: 0, pos_mode: 0, auto_finalize: 0,
};
const LABELED_ONLY = Object.freeze({ bare_nif_scan: "labeled_fields_only" });

/** `metadataToNoteAttributes` emits exactly this shape: { name, value }. */
const order = (attrs: Array<{ name: string; value: string }>, extra: any = {}): any => ({
  order: {
    id: 1, order_number: 0, currency: "EUR", total_price: "143.22",
    customer: { name: "Comitiva Decimal, Lda", email: "vasco@comdec.pt" },
    billing_address: { country_code: "PT", name: "Comitiva Decimal, Lda" },
    note_attributes: attrs,
    ...extra,
  },
});

/** Valid PT NIFs (mod-11): Bestisafil's own, and the generic consumer number. */
const REAL_NIF = "510217729";

describe("where a bare nine-digit number may come from", () => {
  it("takes it from anywhere when the account declared nothing", () => {
    const c = new IxBuilder(cfg).buildInvoiceClient(order([{ name: "stora_id", value: REAL_NIF }]));
    expect(c.fiscal_id).toBe(REAL_NIF);
  });

  it("refuses an unlabeled field when the account asked for labeled fields only", () => {
    const c = new IxBuilder(cfg, undefined, undefined, LABELED_ONLY)
      .buildInvoiceClient(order([{ name: "stora_id", value: REAL_NIF }]));
    expect(c.fiscal_id).toBeUndefined();
  });

  it("still takes it from a field whose name says it is a tax number", () => {
    for (const name of ["nif", "NIF", "vat", "tax_id", "contribuinte", "fiscal_id"]) {
      const c = new IxBuilder(cfg, undefined, undefined, LABELED_ONLY)
        .buildInvoiceClient(order([{ name, value: REAL_NIF }]));
      expect(c.fiscal_id, name).toBe(REAL_NIF);
    }
  });

  it("stops reading the order note, the address and the customer name", () => {
    const o = order([{ name: "stora_id", value: "284915" }], {
      note: `Contribuinte ${REAL_NIF}`,
      billing_address: { country_code: "PT", name: `Comitiva Decimal, Lda ${REAL_NIF}`, address2: REAL_NIF },
    });
    expect(new IxBuilder(cfg).buildInvoiceClient(o).fiscal_id).toBe(REAL_NIF);
    expect(new IxBuilder(cfg, undefined, undefined, LABELED_ONLY).buildInvoiceClient(o).fiscal_id).toBeUndefined();
  });

  // Address line 2 is its own documented rule — "a usable tax id there is used,
  // plain address text is ignored" — but its name says nothing about tax either,
  // so an account that asked for named fields only gets it closed too.
  it("closes address line 2 as well", () => {
    const o = order([{ name: "stora_id", value: "284915" }], {
      billing_address: { country_code: "PT", name: "Comitiva Decimal, Lda", address2: REAL_NIF },
    });
    expect(new IxBuilder(cfg).buildInvoiceClient(o).fiscal_id).toBe(REAL_NIF);
    expect(new IxBuilder(cfg, undefined, undefined, LABELED_ONLY).buildInvoiceClient(o).fiscal_id).toBeUndefined();
  });

  // The gate is about WHERE a number comes from, not about whether it is valid,
  // and it deliberately changes nothing about the latter. A labeled value that
  // fails the PT checksum is still stamped today — measured, not assumed — and
  // that is a separate defect this rule must not be read as having fixed.
  it("does not pretend to validate: an invalid labeled number is stamped either way", () => {
    const o = order([{ name: "nif", value: "123456789" }]);
    expect(new IxBuilder(cfg).buildInvoiceClient(o).fiscal_id).toBe("123456789");
    expect(new IxBuilder(cfg, undefined, undefined, LABELED_ONLY).buildInvoiceClient(o).fiscal_id).toBe("123456789");
  });
});
