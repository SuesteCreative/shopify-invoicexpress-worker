import { describe, it, expect } from "vitest";
import { IxBuilder } from "./builder";

/**
 * A merchant's standing note goes onto every document, and `observations` is
 * where the mandatory fiscal mentions already live under a hard 200-character
 * cap. So the only question that matters here is what gets dropped when the
 * texts do not all fit: a truncated legal mention is a defective document,
 * whereas a truncated merchant note is a cosmetic loss. The note is therefore
 * appended last, and these pin that ordering rather than the wording.
 */

const config = (extra: any = {}): any => ({
  user_id: "u1", shopify_domain: "shop.myshopify.com", ix_document_type: "invoice_receipt",
  vat_included: 1, oss_enabled: 0, b2b_reverse_charge: 0, pos_mode: 0, auto_finalize: 1,
  ix_exemption_reason: "M05", ix_stamp_exemption_note: 1,
  force_tax_rate: null, force_shipping_tax_rate: null,
  ...extra,
});

/** An exempt sale — the case that also carries the bilingual legal mention. */
const exemptOrder = (): any => ({
  id: 1, order_number: 900, currency: "EUR", total_price: "50.00", taxes_included: true,
  created_at: "2026-08-16T10:00:00Z",
  line_items: [{ title: "Livro", sku: "BK-1", price: "50.00", quantity: 1, taxable: true, tax_lines: [] }],
  shipping_lines: [],
  customer: {}, billing_address: {}, shipping_address: {},
});

const normalizedFrom = (raw: any) => ({
  order: {
    id: raw.id, order_number: raw.order_number, currency: raw.currency,
    total: Number(raw.total_price), created_at: raw.created_at, items: [], note: "",
  },
  raw_order: raw,
  client: { name: "Consumidor Final", country: "Portugal" },
} as any);

const observationsFor = (cfg: any) => {
  const { invoice } = new IxBuilder(cfg).createInvoiceFromNormalizedOrder(normalizedFrom(exemptOrder()));
  return (invoice as any).observations ?? "";
};

describe("the merchant's standing invoice note", () => {
  it("is stamped onto the document when configured", () => {
    const obs = observationsFor(config({ custom_invoice_note: "Regime de IVA de caixa" }));
    expect(obs).toContain("Regime de IVA de caixa");
  });

  it("changes nothing when it is not configured", () => {
    const withNote = observationsFor(config({ custom_invoice_note: null }));
    const blank = observationsFor(config({ custom_invoice_note: "   " }));
    expect(withNote).toBe(blank);
    expect(withNote).not.toContain("|  |");
  });

  it("never pushes the legal exemption mention out of the field", () => {
    // A note far longer than the cap: the mention must survive intact and the
    // note is what gets cut.
    const obs = observationsFor(config({ custom_invoice_note: "N".repeat(400) }));
    expect(obs.length).toBeLessThanOrEqual(200);
    expect(obs.startsWith("Isento de IVA ao abrigo do art.º 14.º do CIVA")).toBe(true);
  });

  it("comes after the mandatory texts, not before them", () => {
    const obs = observationsFor(config({ custom_invoice_note: "Nota da loja" }));
    expect(obs.indexOf("Isento de IVA")).toBeLessThan(obs.indexOf("Nota da loja"));
  });
});
