/**
 * A sale in a currency the payment processor never converted.
 *
 * The bug this covers, measured live on WHM's account (2026-09-08): the Stripe
 * account holds a balance per currency, so `balance_transaction.currency`
 * equals the charge's and there is no `exchange_rate` anywhere. The source's
 * settlement conversion finds nothing to do, and 19,95 AUD reached
 * InvoiceXpress as a 19,95 EUR document — 33 of that merchant's last 89
 * payments are not in euros.
 */

import { describe, it, expect, vi } from "vitest";
import { restateOrderInEur } from "./foreign-currency";

/** 1 EUR = 1.7523 AUD, the ECB fixing for 2026-09-03. */
const AUD = 1.7523;
const rateStub = (rate: number) => vi.fn(async () => ({ rate, source: "ECB test" }));

const order = (over: Record<string, any> = {}): any => ({
  total: 19.95,
  currency: "AUD",
  created_at: "2026-09-03T01:48:23.000Z",
  items: [{ id: 1, quantity: 1, unit_price: 19.95, tax: { value: 0, unit_amount: 0 } }],
  ...over,
});

const gross = (o: any) => o.items.reduce(
  (acc: number, it: any) => acc + it.unit_price * (it.quantity ?? 1) * (1 + (it.tax?.value ?? 0) / 100),
  0,
);

describe("restateOrderInEur", () => {
  it("turns a foreign sale into euros at the ECB rate for the document's date", async () => {
    const o = order();
    const fetchRate = rateStub(AUD);

    const fx = await restateOrderInEur(o, { fetchRate });

    expect(fetchRate).toHaveBeenCalledWith("AUD", "2026-09-03");
    expect(o.currency).toBe("EUR");
    // Within a cent of the ideal conversion: the lines are rounded, and they
    // are what the total is built from.
    expect(Math.abs(o.total - 19.95 / AUD)).toBeLessThanOrEqual(0.01);
    expect(o.items[0].unit_price).toBeCloseTo(o.total, 2);
    expect(fx?.code).toBe("AUD");
    expect(fx?.amount).toBe(19.95);
  });

  it("records what the buyer paid, at a rate that prints back to it", async () => {
    const o = order();

    await restateOrderInEur(o, { fetchRate: rateStub(AUD) });

    // IX derives the second figure as total * rate. It has to land on the
    // amount actually paid, which is what the six decimals are for.
    const printed = Math.round(o.total * o.paid_in_foreign_currency.rate * 100) / 100;
    expect(printed).toBe(19.95);
  });

  it("leaves a euro sale alone and asks for no rate", async () => {
    const o = order({ currency: "EUR" });
    const fetchRate = rateStub(AUD);

    expect(await restateOrderInEur(o, { fetchRate })).toBeNull();
    expect(fetchRate).not.toHaveBeenCalled();
    expect(o.total).toBe(19.95);
  });

  it("does not convert twice a sale the source already restated", async () => {
    // Stripe converted it and said so: converting again would divide by the
    // rate a second time.
    const o = order({ currency: "EUR", paid_in_foreign_currency: { code: "AUD", amount: 19.95, rate: 1.7523 } });
    const fetchRate = rateStub(AUD);

    expect(await restateOrderInEur(o, { fetchRate })).toBeNull();
    expect(fetchRate).not.toHaveBeenCalled();
  });

  it("keeps the converted lines summing to the converted total", async () => {
    // Rounding each line independently is what leaves the sum a cent off the
    // total, and the reconcile guard rejects the document over exactly that.
    const o = order({
      total: 289.9,
      items: [
        { id: 1, quantity: 3, unit_price: 79.9, tax: { value: 0, unit_amount: 0 } },
        { id: 2, quantity: 1, unit_price: 50.2, tax: { value: 0, unit_amount: 0 } },
      ],
    });

    await restateOrderInEur(o, { fetchRate: rateStub(AUD) });

    expect(Math.round(gross(o) * 100) / 100).toBe(o.total);
  });

  it("keeps taxed lines summing to the converted total", async () => {
    const o = order({
      total: 123,
      items: [
        { id: 1, quantity: 2, unit_price: 40, tax: { value: 23, unit_amount: 9.2 } },
        { id: 2, quantity: 1, unit_price: 20.33, tax: { value: 6, unit_amount: 1.22 } },
      ],
    });

    await restateOrderInEur(o, { fetchRate: rateStub(AUD) });

    expect(Math.round(gross(o) * 100) / 100).toBe(o.total);
  });

  it("refuses the sale when the rate cannot be had, and changes nothing", async () => {
    // Fails closed on purpose: an unbilled order is a problem someone can see,
    // a certified document for the wrong amount is not.
    const o = order();
    const fetchRate = vi.fn(async () => { throw new Error("BCE indisponível"); });

    await expect(restateOrderInEur(o, { fetchRate })).rejects.toThrow("BCE indisponível");
    expect(o.total).toBe(19.95);
    expect(o.currency).toBe("AUD");
  });
});
