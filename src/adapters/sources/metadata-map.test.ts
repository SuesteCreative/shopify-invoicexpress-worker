/**
 * A merchant whose checkout is their own software knows the buyer's fiscal
 * name, tax number and country, and sends them in the payment's metadata. We
 * read that metadata for two things only — hunting a NIF in free text, and
 * matching routing rules — and threw the rest away, so invoices went out as
 * "Consumidor Final" with the answer sitting on the payment.
 *
 * The two rules pinned here matter more than any single field: metadata only
 * ever fills blanks, and it never moves money.
 */

import { describe, it, expect } from "vitest";
import { parseMetadataMap, applyMetadataMap, applyMetadataVatRate } from "./metadata-map";

const MAP = JSON.stringify({
  name: "billing_name",
  email: "billing_email",
  country: "billing_country",
  address1: "billing_address",
  city: "billing_city",
  postal_code: "billing_zip",
  vat: "nif",
  vat_rate: "vat_rate",
});

const order = (attrs: Array<[string, string]>, over: any = {}): any => ({
  order: {
    id: 1,
    order_number: 0,
    total: 123,
    note_attributes: attrs.map(([name, value]) => ({ name, value })),
    customer: { name: "", email: "" },
    billing_address: {},
    items: [{
      id: 1, quantity: 1, unit_price: 123,
      tax: { name: "VAT", value: 0, unit_amount: 0 },
      discount: { name: "", percent: 0 }, title: "Linha",
    }],
    ...over,
  },
});

describe("parseMetadataMap", () => {
  it("ignores a map that is not valid JSON rather than losing the sale", () => {
    expect(parseMetadataMap("{not json")).toBeNull();
  });

  it("ignores fields it does not know how to fill", () => {
    expect(parseMetadataMap('{"unknown_field":"x"}')).toBeNull();
    expect(parseMetadataMap('{"name":"n","unknown_field":"x"}')).toEqual({ name: "n" });
  });

  it("is absent by default, which is every connection invoicing today", () => {
    expect(parseMetadataMap(null)).toBeNull();
    expect(parseMetadataMap("")).toBeNull();
  });
});

describe("applyMetadataMap", () => {
  const map = parseMetadataMap(MAP)!;

  it("fills the buyer the payment never named", () => {
    const n = order([["billing_name", "Ana Marques"], ["billing_email", "ana@example.pt"]]);
    const filled = applyMetadataMap(n, map);

    expect(n.order.customer.name).toBe("Ana Marques");
    expect(n.order.billing_address.name).toBe("Ana Marques");
    expect(n.order.customer.email).toBe("ana@example.pt");
    expect(filled).toContain("name");
  });

  it("never overwrites what Stripe itself stated", () => {
    const n = order([["billing_name", "Metadata Name"]], { customer: { name: "Charge Name", email: "" } });
    applyMetadataMap(n, map);

    expect(n.order.customer.name).toBe("Charge Name");
  });

  it("reads a two-letter country as the code, because that is what gates the tax treatment", () => {
    const n = order([["billing_country", "au"]]);
    applyMetadataMap(n, map);

    expect(n.order.billing_address.country_code).toBe("AU");
  });

  it("reads a longer value as the country name, not as a code", () => {
    const n = order([["billing_country", "Australia"]]);
    applyMetadataMap(n, map);

    expect(n.order.billing_address.country).toBe("Australia");
    expect(n.order.billing_address.country_code ?? "").toBe("");
  });

  it("hands a tax number to the extractor instead of writing it onto the document", () => {
    // Writing fiscal_id straight from metadata is how address words ended up as
    // NIFs on 200 documents. The extractor validates; this does not.
    const n = order([["nif", "PT501442600"]]);
    applyMetadataMap(n, map);

    const added = n.order.note_attributes.find((a: any) => a.name === "vat (metadata)");
    expect(added?.value).toBe("PT501442600");
    expect(n.order.billing_address.fiscal_id).toBeUndefined();
  });

  it("matches keys case-insensitively", () => {
    const n = order([["Billing_Name", "Ana Marques"]]);
    applyMetadataMap(n, map);

    expect(n.order.customer.name).toBe("Ana Marques");
  });

  it("does nothing at all when the payment carries no metadata", () => {
    const n = order([]);
    expect(applyMetadataMap(n, map)).toEqual([]);
  });
});

describe("applyMetadataVatRate", () => {
  const map = parseMetadataMap(MAP)!;

  it("splits an untaxed total into net and VAT without moving the total", () => {
    const n = order([["vat_rate", "23"]]);
    const rate = applyMetadataVatRate(n, map);

    expect(rate).toBe(23);
    expect(n.order.items[0].tax.value).toBe(23);
    expect(n.order.items[0].unit_price).toBeCloseTo(100, 2);
    // 100.00 net + 23% = 123.00, exactly what was paid.
    expect(n.order.items[0].unit_price * 1.23).toBeCloseTo(123, 2);
  });

  it("accepts the shapes merchants actually send", () => {
    for (const raw of ["23%", "23.0", "23,0"]) {
      const n = order([["vat_rate", raw]]);
      expect(applyMetadataVatRate(n, map)).toBe(23);
    }
  });

  it("leaves a line that already carries VAT alone", () => {
    const n = order([["vat_rate", "23"]]);
    n.order.items[0].tax = { name: "VAT", value: 6, unit_amount: 1 };

    expect(applyMetadataVatRate(n, map)).toBeNull();
    expect(n.order.items[0].tax.value).toBe(6);
  });

  it("refuses a rate that is not one", () => {
    for (const raw of ["", "abc", "-5", "150"]) {
      const n = order([["vat_rate", raw]]);
      expect(applyMetadataVatRate(n, map)).toBeNull();
      expect(n.order.items[0].tax.value).toBe(0);
    }
  });
});
