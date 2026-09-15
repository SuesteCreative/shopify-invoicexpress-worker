import { describe, it, expect } from "vitest";
import { mirrorItemsFromIxDocument, planRefundCredit, type LineSource, type MirrorLine } from "./credit-mirror";

/**
 * Bikini Books OL1373, the sale this module exists because of.
 *
 * A book at 42,00 € with 6% baked in and shipping at 15,00 € with 23% baked in,
 * as InvoiceXpress stored them: net unit prices ceiled to the cent with the
 * sub-cent residue carried as a positive discount percentage.
 */
const BOOK: MirrorLine = {
  quantity: 1,
  name: "Alphabettes Soup: Feminist Approaches to Type",
  description: "SKU: ABS-01",
  unit_price: 39.63,
  tax: { id: 673084, name: "IVA6", value: 6 },
  discount: 0.0186,
};
const SHIPPING: MirrorLine = {
  quantity: 1,
  name: "Portes de envio — CTT",
  unit_price: 12.20,
  tax: { id: 673085, name: "IVA23", value: 23 },
  discount: 0.04,
};
const DOC_ITEMS = [BOOK, SHIPPING];
const SOURCES: LineSource[] = [{ kind: "line", id: 17714669912340 }, { kind: "shipping", id: 55501 }];
const DOC_TOTAL = 57;

const base = {
  docTotal: DOC_TOTAL,
  docItems: DOC_ITEMS,
  sources: SOURCES,
  taxesIncluded: true,
  alreadyCredited: 0,
  rawRefund: null as any,
};

const rateOf = (t: any) => (typeof t === "number" ? t : t.value);

describe("a credit note mirrors the invoice", () => {
  it("credits a returned book at the invoice's 6%, never at 5.67%", () => {
    // The defect: 2,38 / 42,00 = 5,67%, because on a VAT-inclusive shop the
    // refund's `subtotal` is the gross. InvoiceXpress has no such tax, falls
    // back to the exempt one, and refuses the document for having no exemption
    // reason — which is why this refund was never credited.
    const plan = planRefundCredit({
      ...base,
      refund: { refundId: "1041494901012", amount: 42, lineItems: [{ id: 17714669912340, quantity: 1, subtotal: 42, total_tax: 2.38 }] },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.items).toHaveLength(1);
    expect(rateOf(plan.items[0].tax)).toBe(6);
    expect(plan.items[0].unit_price).toBe(BOOK.unit_price);
    expect(plan.items[0].name).toBe(BOOK.name);
    expect(plan.total).toBe(42);
  });

  it("credits a shipping-only refund from the invoice's shipping line", () => {
    // Shopify sends no refund_line_items for shipping: the money is in
    // order_adjustments, amount and tax apart, and it writes a ± discrepancy
    // pair alongside that nets to nothing.
    const plan = planRefundCredit({
      ...base,
      refund: { refundId: "1041494835476", amount: 15, lineItems: [] },
      rawRefund: {
        order_adjustments: [
          { kind: "shipping_refund", amount: "-12.20", tax_amount: "-2.80" },
          { kind: "refund_discrepancy", amount: "15.00", tax_amount: "0.00" },
          { kind: "refund_discrepancy", amount: "-15.00", tax_amount: "0.00" },
        ],
      },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.items).toHaveLength(1);
    expect(rateOf(plan.items[0].tax)).toBe(23);
    expect(plan.items[0].name).toBe(SHIPPING.name);
    expect(plan.total).toBe(15);
  });

  it("never invents a line of its own", () => {
    const plans = [
      planRefundCredit({ ...base, refund: { refundId: "a", amount: 42, lineItems: [{ id: 17714669912340, quantity: 1, subtotal: 42, total_tax: 2.38 }] } }),
      planRefundCredit({ ...base, refund: { refundId: "b", amount: 57, lineItems: [] } }),
    ];
    for (const plan of plans) {
      expect(plan.ok).toBe(true);
      if (!plan.ok) continue;
      for (const line of plan.items) {
        expect(line.name).not.toMatch(/refund amount/i);
        // Every rate on the credit note is a rate the invoice itself carries.
        expect(DOC_ITEMS.map(i => rateOf(i.tax))).toContain(rateOf(line.tax));
      }
    }
  });

  it("still finds the article when today's builder splits the shipping differently", () => {
    // Estrela #1327, issued in May with ONE shipping line (2,03 € at 23%). The
    // same order rebuilt today comes out with shipping in two bands. Aligning
    // every line by position refused this refund; only the articles need to align.
    const plan = planRefundCredit({
      ...base,
      sources: [{ kind: "line", id: 17714669912340 }, { kind: "shipping", id: 55501 }, { kind: "shipping", id: 55501 }],
      rebuilt: [
        BOOK,
        { quantity: 1, name: "Portes de envio — CTT (23%)", unit_price: 12.18, tax: { name: "IVA23", value: 23 }, discount: 0.05 },
        { quantity: 1, name: "Portes de envio — CTT (0%)", unit_price: 0.03, tax: { name: "IVA0", value: 0 }, discount: 13.0435 },
      ],
      refund: { refundId: "book", amount: 42, lineItems: [{ id: 17714669912340, quantity: 1, subtotal: 42, total_tax: 2.38 }] },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.items.map(i => i.name)).toEqual([BOOK.name]);
  });

  it("credits every shipping band the invoice actually carries", () => {
    // Bikini Books 79/OL as it really stands: shipping in two bands.
    const ship23: MirrorLine = { quantity: 1, name: "Portes de envio — European Shipping CTT (23%)", unit_price: 12.18, tax: { name: "IVA23", value: 23 }, discount: 0.05 };
    const ship0: MirrorLine = { quantity: 1, name: "Portes de envio — European Shipping CTT (0%)", unit_price: 0.03, tax: { name: "IVA0", value: 0 }, discount: 13.0435 };
    const plan = planRefundCredit({
      ...base,
      docItems: [BOOK, ship23, ship0],
      sources: [{ kind: "line", id: 17714669912340 }, { kind: "shipping", id: 55501 }, { kind: "shipping", id: 55501 }],
      refund: { refundId: "1041494835476", amount: 15, lineItems: [] },
      rawRefund: { order_adjustments: [{ kind: "shipping_refund", amount: "-12.20", tax_amount: "-2.80" }] },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.items).toEqual([ship23, ship0]);
    expect(plan.total).toBe(15);
  });

  it("mirrors the whole document when the whole order is refunded", () => {
    const plan = planRefundCredit({ ...base, refund: { refundId: "full", amount: 57, lineItems: [] } });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.basis).toBe("document");
    expect(plan.items).toEqual(DOC_ITEMS);
    expect(plan.total).toBe(57);
  });

  it("credits only the units returned, at the invoice's own unit price", () => {
    // 4 × 25,00 € with 23% included; three units come back.
    const line: MirrorLine = { quantity: 4, name: "Produto A", unit_price: 20.33, tax: { name: "IVA23", value: 23 }, discount: 0.0236 };
    const plan = planRefundCredit({
      docTotal: 100,
      docItems: [line],
      sources: [{ kind: "line", id: 900 }],
      taxesIncluded: true,
      alreadyCredited: 0,
      rawRefund: null,
      refund: { refundId: "qty", amount: 75, lineItems: [{ id: 900, quantity: 3, subtotal: 75, total_tax: 14.02 }] },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].quantity).toBe(3);
    expect(plan.items[0].unit_price).toBe(20.33);
    expect(plan.items[0].discount).toBe(0.0236);
    expect(plan.total).toBe(75);
  });

  it("credits only the articles returned when several were sold", () => {
    // A 10 + B 80 + C 5 + D 5, prices VAT-exclusive this time; A and B come back.
    const mk = (name: string, price: number): MirrorLine => ({ quantity: 1, name, unit_price: price, tax: { name: "IVA0", value: 0 } });
    const items = [mk("Produto A", 10), mk("Produto B", 80), mk("Produto C", 5), mk("Produto D", 5)];
    const plan = planRefundCredit({
      docTotal: 100,
      docItems: items,
      sources: [1, 2, 3, 4].map(id => ({ kind: "line", id })) as LineSource[],
      taxesIncluded: false,
      alreadyCredited: 0,
      rawRefund: null,
      refund: {
        refundId: "ab", amount: 90,
        lineItems: [
          { id: 1, quantity: 1, subtotal: 10, total_tax: 0 },
          { id: 2, quantity: 1, subtotal: 80, total_tax: 0 },
        ],
      },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.items.map(i => i.name)).toEqual(["Produto A", "Produto B"]);
    expect(plan.total).toBe(90);
  });
});

describe("it refuses rather than approximate", () => {
  it("refuses a refund that does not fit what is left of the invoice", () => {
    // The 4th through 22nd credit notes of 2026-09-14: three 15 € notes had
    // already been issued against a 57 € invoice. IX only refuses at finalize,
    // and only against the invoice total, so it let all three through.
    const plan = planRefundCredit({
      ...base,
      alreadyCredited: 45,
      refund: { refundId: "1041494835476", amount: 15, lineItems: [] },
      rawRefund: { order_adjustments: [{ kind: "shipping_refund", amount: "-12.20", tax_amount: "-2.80" }] },
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toContain("já tem 45.00 € creditados");
  });

  it("refuses when the invoice total cannot be read, instead of skipping every check", () => {
    // NaN compares false, so an unread total would pass the headroom and floor
    // checks rather than fail them.
    const plan = planRefundCredit({
      ...base,
      docTotal: Number(undefined),
      refund: { refundId: "nan", amount: 42, lineItems: [{ id: 17714669912340, quantity: 1, subtotal: 42, total_tax: 2.38 }] },
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toContain("não consigo ler o total da fatura");
  });

  it("refuses discretionary money that matches no line of the invoice", () => {
    const plan = planRefundCredit({ ...base, refund: { refundId: "cash", amount: 5, lineItems: [] } });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toContain("não devolve nenhum artigo nem portes");
  });

  it("refuses a partial-value refund of a line, instead of discounting the mirror", () => {
    const plan = planRefundCredit({
      ...base,
      refund: { refundId: "half", amount: 21, lineItems: [{ id: 17714669912340, quantity: 1, subtotal: 21, total_tax: 1.19 }] },
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toContain("não se espelha");
  });

  it("refuses when an article on the invoice no longer matches the order", () => {
    // A document edited by hand after issue: the book now sits at 23% on the
    // invoice. Attaching the refund to it anyway would credit the wrong rate.
    const plan = planRefundCredit({
      ...base,
      refund: { refundId: "edited", amount: 42, lineItems: [{ id: 17714669912340, quantity: 1, subtotal: 42, total_tax: 2.38 }] },
      rebuilt: [{ ...BOOK, tax: { name: "IVA23", value: 23 } }, SHIPPING],
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toContain("está a 6% na fatura e a 23% na encomenda");
  });

  it("credits a cancelled line even though no money moved", () => {
    // lliberta #1021: a paid order cancelled in Shopify arrives as a refund with
    // `restock_type: cancel` and NO refund transaction. The line left the sale;
    // a cancelled line is credited like a refunded one. Here the book is
    // cancelled and the order is now worth only its shipping.
    const plan = planRefundCredit({
      ...base,
      orderCurrentTotal: 15,
      refund: { refundId: "cancel-book", amount: 44.38, lineItems: [{ id: 17714669912340, quantity: 1, subtotal: 42, total_tax: 2.38 }] },
      rawRefund: { transactions: [] },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.items.map(i => i.name)).toEqual([BOOK.name]);
    expect(plan.total).toBe(42);
  });

  it("has nothing to credit when the invoice already matches what the order is worth", () => {
    // Estrela #1401: two necklaces ordered, one paid, invoiced at 89,49 €; the
    // unpaid one is then "returned" at 0,00 € and the order is still worth 89,49 €.
    const plan = planRefundCredit({
      ...base,
      orderCurrentTotal: 57,
      refund: { refundId: "edit", amount: 44.38, lineItems: [{ id: 17714669912340, quantity: 1, subtotal: 42, total_tax: 2.38 }] },
      rawRefund: { transactions: [] },
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.nothingToCredit).toBe(true);
  });

  it("never credits the invoice below what the order is still worth", () => {
    const plan = planRefundCredit({
      ...base,
      orderCurrentTotal: 30,
      refund: { refundId: "floor", amount: 42, lineItems: [{ id: 17714669912340, quantity: 1, subtotal: 42, total_tax: 2.38 }] },
      rawRefund: { transactions: [] },
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.nothingToCredit).toBeUndefined();
    expect(plan.reason).toContain("a encomenda ainda vale 30.00 €");
  });

  it("has nothing to credit for a refund that moves no line, no shipping and no money", () => {
    const plan = planRefundCredit({
      ...base,
      refund: { refundId: "bookkeeping", amount: 0, lineItems: [] },
      rawRefund: { transactions: [], order_adjustments: [
        { kind: "refund_discrepancy", amount: "5.00", tax_amount: "0.00" },
        { kind: "refund_discrepancy", amount: "-5.00", tax_amount: "0.00" },
      ] },
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.nothingToCredit).toBe(true);
  });

  it("totals what the transactions paid back, not what the normalizer computed", () => {
    const plan = planRefundCredit({
      ...base,
      refund: { refundId: "1041494901012", amount: 44.38, lineItems: [{ id: 17714669912340, quantity: 1, subtotal: 42, total_tax: 2.38 }] },
      rawRefund: { transactions: [
        { kind: "refund", status: "success", amount: "42.00" },
        { kind: "refund", status: "failure", amount: "42.00" },
      ] },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.total).toBe(42);
  });

  it("refuses an adjustment kind it does not understand", () => {
    const plan = planRefundCredit({
      ...base,
      refund: { refundId: "restock", amount: 40, lineItems: [] },
      rawRefund: { order_adjustments: [{ kind: "restocking_fee", amount: "-40.00", tax_amount: "0.00" }] },
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toContain("restocking_fee");
  });
});

describe("mirrorItemsFromIxDocument", () => {
  it("keeps a line discount, which is part of what the line is worth", () => {
    const { items, gross } = mirrorItemsFromIxDocument({
      total: 57,
      items: [
        { quantity: 1, name: BOOK.name, description: BOOK.description, unit_price: 39.63, tax: { id: 673084, name: "IVA6", value: 6 }, discount: 0.0186 },
        { quantity: 1, name: SHIPPING.name, unit_price: 12.20, tax: { id: 673085, name: "IVA23", value: 23 }, discount: 0.04 },
      ],
    });
    expect(items[0].discount).toBe(0.0186);
    expect(gross).toBe(57);
  });

  it("falls back to the line subtotal when the document carries a header discount", () => {
    // 99,00 € at 60,61% off, then a further 20,10 € off the document: mirroring
    // the lines alone credits 47,97 € against an invoice of 23,24 €.
    const { items, gross } = mirrorItemsFromIxDocument({
      total: 23.24,
      items: [{ quantity: 1, name: "Serviço", unit_price: 99, tax: { name: "IVA0", value: 0 }, discount: 60.61, subtotal: 23.24 }],
    });
    expect(items[0].unit_price).toBe(23.24);
    expect(items[0].discount).toBeUndefined();
    expect(gross).toBe(23.24);
  });

  it("refuses a read-back it cannot reproduce", () => {
    expect(() => mirrorItemsFromIxDocument({
      total: 100,
      items: [{ quantity: 1, name: "Serviço", unit_price: 10, tax: { name: "IVA0", value: 0 } }],
    })).toThrow(/não credito um valor diferente/);
  });
});
