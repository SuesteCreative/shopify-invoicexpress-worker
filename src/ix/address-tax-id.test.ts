import { describe, it, expect } from "vitest";
import { IxBuilder, nifHoldReason } from "./builder";

// Minimal config; only the fields buildInvoiceClient/inspectAddressTaxId read.
const cfg: any = {
  user_id: "u1", shopify_domain: "x.myshopify.com", ix_document_type: "invoice_receipt",
  vat_included: 1, oss_enabled: 1, b2b_reverse_charge: 0, pos_mode: 0, auto_finalize: 0,
};
const b = () => new IxBuilder(cfg);

// Cast: these fixtures carry only the fields under test, not a whole Normalized.
const order = (billing: any = {}, shipping: any = null, extra: any = {}): any => ({
  order: {
    id: 1, order_number: 1, currency: "EUR", total_price: "10.00",
    customer: { first_name: "Ana", last_name: "Silva", name: "Ana Silva" },
    billing_address: { country_code: "PT", name: "Ana Silva", ...billing },
    ...(shipping ? { shipping_address: { country_code: "PT", ...shipping } } : {}),
    ...extra,
  },
});

describe("address line 2 tax id", () => {
  it("ignores ordinary address text", () => {
    for (const a2 of ["Silva", "Lote 1,3H", "4º andar sala F", "Bloco1,Apartamento 0A", "Setubal"]) {
      expect(b().inspectAddressTaxId(order({ address2: a2 })).kind).toBe("none");
      expect(b().buildInvoiceClient(order({ address2: a2 })).fiscal_id).toBeUndefined();
    }
  });

  it("uses a valid PT NIF found in address line 2", () => {
    const r = b().inspectAddressTaxId(order({ address2: "517635275" }));
    expect(r).toMatchObject({ kind: "valid", nif: "517635275" });
  });

  it("reads the shipping address too, not just billing", () => {
    const c = b().buildInvoiceClient(order({}, { address2: "229244777" }));
    expect(c.fiscal_id).toBe("229244777");
  });

  it("drafts the document when address line 2 has an invalid PT tax id", () => {
    // 500000001 fails the checksum and is in the company range, so it reads as
    // a mistyped tax id rather than a phone number.
    const r = b().inspectAddressTaxId(order({ address2: "500000001" }));
    expect(r).toMatchObject({ kind: "invalid", raw: "500000001" });
  });

  it("never stamps the invalid number as the client's fiscal id", () => {
    expect(b().buildInvoiceClient(order({ address2: "500000001" })).fiscal_id).toBeUndefined();
  });

  it("flags the build so the caller drafts it instead of finalizing", () => {
    // A build needs line items to get as far as returning, so give it one.
    const withItem = order({ address2: "500000001" }, null, {
      line_items: [{ title: "T", quantity: 1, price: "10.00", tax_lines: [] }],
      total_price: "10.00",
    });
    (withItem as any).raw_order = withItem.order;
    const build = b().createInvoiceFromNormalizedOrder(withItem);
    expect(build.nifHold).toMatchObject({ raw: "500000001", field: "billing.address2" });
    expect(nifHoldReason(build.nifHold!)).toContain("500000001");
    expect(build.invoice.client.fiscal_id).toBeUndefined();
  });

  it("resolves the buyer's email from the order when there is no customer object", () => {
    // Guest checkout: Shopify leaves `customer` null but keeps the address the
    // shopper typed on the order itself. Reading only `customer.email` produced
    // an IX client with no email, so the invoice could never be sent.
    const guest = order({}, null, { customer: null, email: "guest@example.com" });
    (guest as any).raw_order = { email: "guest@example.com" };
    expect(b().buildInvoiceClient(guest).email).toBe("guest@example.com");

    const contactOnly = order({}, null, { customer: null });
    (contactOnly as any).raw_order = { contact_email: "contact@example.com" };
    expect(b().buildInvoiceClient(contactOnly).email).toBe("contact@example.com");

    // The customer record still wins when it has one.
    const withCustomer = order({}, null, { customer: { name: "Ana Silva", email: "ana@example.com" }, email: "other@example.com" });
    expect(b().buildInvoiceClient(withCustomer).email).toBe("ana@example.com");

    // A POS counter sale has none of them — empty, not garbage.
    expect(b().buildInvoiceClient(order({}, null, { customer: null, email: "" })).email).toBe("");
  });

  it("treats a Portuguese mobile number in the address as text, not a bad NIF", () => {
    // Real case: one Angel Piercing customer keeps their phone in the delivery
    // address, which held two orders worth EUR 841 until this was distinguished.
    for (const phone of ["962191562", "912345678", "935555555"]) {
      expect(b().inspectAddressTaxId(order({ address2: phone })).kind).toBe("none");
    }
  });

  it("passes a foreign tax id through instead of judging it by PT rules", () => {
    const r = b().inspectAddressTaxId(order({ country_code: "IT", address2: "04883230619" }));
    expect(r).toMatchObject({ kind: "valid", nif: "04883230619" });
  });

  it("never turns a word into a country-prefixed VAT number", () => {
    for (const src of [{ address2: "LASALLE College of the Arts" }, { company: "Boutique Lily" }]) {
      expect(b().buildInvoiceClient(order(src)).fiscal_id).toBeUndefined();
    }
  });

  it("strips a redundant PT prefix and an unseparated NIF label", () => {
    expect(b().buildInvoiceClient(order({ company: "PT515640158" })).fiscal_id).toBe("515640158");
    expect(b().buildInvoiceClient(order({ company: "NIF216010993" })).fiscal_id).toBe("216010993");
  });

  it("recovers a NIF pasted into the name and trims the name to the IX limit", () => {
    const long = "NATHALIE OUGARANE NATHALIE OUGARANE-PRESTAÇÃO DE SERVIÇOS E ATIVIDADES TURISTICO-IMOBILIÁRIAS,UNIPESSOAL LDA 519227921";
    const c = b().buildInvoiceClient(order({ name: long }, null, { customer: { name: long } }));
    expect(c.fiscal_id).toBe("519227921");
    expect((c.name ?? "").length).toBeLessThanOrEqual(100);
  });
});
