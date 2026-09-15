import { describe, it, expect } from "vitest";
import { planMoloniRefundCredit } from "./moloni-destination";
import { documentNotCreditable } from "../../ix/credit-mirror";

/**
 * Stripe, Lodgify and EuPago refund an amount, not articles. A Moloni credit
 * note for one used to be a placeholder "Rioko Refund Delta" product at the
 * document's highest rate, related to whichever line came first; Moloni refused
 * MY VAN's from 06/08. The credit note now mirrors the document's own lines.
 */

// Moloni's `net_value` is the total WITH VAT and `gross_value` the base.
const oneLine = {
  document_id: 1021407293,
  status: 1,
  net_value: 120,
  gross_value: 97.56,
  customer_id: 55,
  products: [{
    product_id: 901, document_product_id: 7001, name: "Aluguer autocaravana",
    qty: 1, price: 97.561, discount: 0,
    taxes: [{ tax_id: 3476562, value: 23, cumulative: 0 }],
  }],
};

const twoRates = {
  document_id: 1020784353,
  status: 1,
  net_value: 130,
  gross_value: 118.73,
  customer_id: 56,
  products: [
    { product_id: 911, document_product_id: 7101, name: "Alojamento", qty: 1, price: 94.3396, discount: 0,
      taxes: [{ tax_id: 11, value: 6, cumulative: 0 }] },
    { product_id: 912, document_product_id: 7102, name: "Limpeza e extras", qty: 1, price: 24.3902, discount: 0,
      taxes: [{ tax_id: 12, value: 23, cumulative: 0 }] },
  ],
};

const refund = (grossAmount: number, extra: Record<string, unknown> = {}) =>
  ({ refundId: "re_test", grossAmount, alreadyCredited: 0, ...extra });

const gross = (p: any) => p.price * p.qty * (1 - p.discount / 100) * (1 + (p.taxes?.[0]?.value ?? 0) / 100);

describe("planMoloniRefundCredit", () => {
  it("credits a full refund with the document's own line, product and tax rule", () => {
    const plan = planMoloniRefundCredit(oneLine, refund(120), "M01");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.basis).toBe("document");
    expect(plan.total).toBe(120);
    expect(plan.products).toEqual([{
      product_id: 901, related_id: 7001, name: "Aluguer autocaravana",
      qty: 1, price: 97.561, discount: 0, order: 1,
      taxes: [{ tax_id: 3476562, value: 23, order: 1, cumulative: 0 }],
    }]);
  });

  it("credits a partial refund as the same line at the refunded share, on the cent", () => {
    const plan = planMoloniRefundCredit(oneLine, refund(50), "M01");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.basis).toBe("proportional");
    expect(plan.total).toBe(50);
    expect(plan.products).toHaveLength(1);
    expect(plan.products[0]).toMatchObject({ product_id: 901, related_id: 7001, taxes: [{ tax_id: 3476562, value: 23 }] });
    expect(Math.abs(gross(plan.products[0]) - 50)).toBeLessThan(0.006);
  });

  it("keeps each rate on its own line when a document carries two", () => {
    const plan = planMoloniRefundCredit(twoRates, refund(65), "M01");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.total).toBe(65);
    expect(plan.products.map((p) => [p.related_id, p.taxes?.[0]?.value])).toEqual([[7101, 6], [7102, 23]]);
    expect(Math.abs(gross(plan.products[0]) - 50)).toBeLessThan(0.011);
    expect(Math.abs(gross(plan.products[1]) - 15)).toBeLessThan(0.011);
  });

  it("refuses a refund that does not fit in what is left of the document", () => {
    const plan = planMoloniRefundCredit(oneLine, refund(50, { alreadyCredited: 100 }), "M01");
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toContain("não cabe");
  });

  it("refuses a document whose lines do not add up to its total", () => {
    const plan = planMoloniRefundCredit({ ...oneLine, net_value: 100 }, refund(100), "M01");
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toContain("não consigo reconstruir");
  });

  it("refuses a line Moloni could not relate the credit to", () => {
    const doc = { ...oneLine, products: [{ ...oneLine.products[0], document_product_id: undefined }] };
    const plan = planMoloniRefundCredit(doc, refund(120), "M01");
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toContain("identificador de linha");
  });

  it("credits a sale paid in another currency by its share, landing a full refund on the document", () => {
    const full = planMoloniRefundCredit(oneLine, refund(130, { converted: true, saleTotal: 130 }), "M01");
    expect(full.ok && full.total).toBe(120);
    const half = planMoloniRefundCredit(oneLine, refund(65, { converted: true, saleTotal: 130 }), "M01");
    expect(half.ok && half.total).toBe(60);
  });
});

describe("documentNotCreditable", () => {
  it("leaves a draft open for a later replay, and closes an annulled or deleted document quietly", () => {
    expect(documentNotCreditable("1", "draft")).toMatchObject({ status: "refused", documentState: "draft" });
    expect(documentNotCreditable("1", "draft").nothingToCredit).toBeUndefined();
    expect(documentNotCreditable("1", "canceled")).toMatchObject({ documentState: "canceled", nothingToCredit: true });
    expect(documentNotCreditable("1", "deleted")).toMatchObject({ documentState: "deleted", nothingToCredit: true });
  });
});
