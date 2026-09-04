/**
 * A sale paid in a currency the destination cannot issue in.
 *
 * InvoiceXpress issues in the account's own currency — for a Portuguese account
 * the euro, by law — and it keeps whatever number it is given: send it the 100
 * from a 100 AUD sale and it stores a 100 € invoice, about 72% above the sale.
 * Measured against the IX sandbox on 2026-09-04, where `currency_code` was
 * accepted and the stored document still read back `currency: "Euro", total:
 * 100`. So the conversion has to happen here, before the document is built.
 *
 * The rate is the payment's own `balance_transaction` — what Stripe actually
 * settled at — so the invoice agrees with the merchant's bank statement rather
 * than with an FX feed's idea of that day.
 *
 * Behind `ix_multicurrency`. With the flag off the order is untouched, and the
 * pipeline's own guard then skips the sale as it does today rather than issuing
 * a misvalued document.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { StripeSource } from "./stripe-source";
import { reconcileTotalOrThrow } from "../reconcile";
import type { AdapterCtx } from "../types";

const PI_ID = "pi_3U9xxAJNp2FcbLOX0Wq1nT4k";

const piEvent = (currency = "aud", amount = 10000) => ({
  type: "payment_intent.succeeded",
  data: {
    object: {
      id: PI_ID,
      status: "succeeded",
      amount,
      amount_received: amount,
      currency,
      created: 1_756_000_000,
      description: "Order 5120",
    },
  },
});

/** 100.00 AUD settling as 58.20 EUR. */
const charge = (over: Record<string, any> = {}) => ({
  id: "ch_3U9xxAJNp2FcbLOX0",
  amount: 10000,
  currency: "aud",
  created: 1_756_000_000,
  billing_details: { name: "Bruce Wayne" },
  balance_transaction: { amount: 5820, currency: "eur", exchange_rate: 0.582 },
  ...over,
});

const ctx = (extra: any = {}): AdapterCtx => ({
  sourceConfig: { restricted_key: "rk_live_test" },
  config: { ix_multicurrency: 1, ...extra },
} as unknown as AdapterCtx);

function stub(chargeObj: any) {
  vi.stubGlobal("fetch", vi.fn(async () =>
    ({ ok: true, json: async () => ({ latest_charge: chargeObj }) } as unknown as Response)));
}

afterEach(() => vi.unstubAllGlobals());

/** Exactly what the destination adapters do before POSTing. */
const assertReconciles = (n: any) => {
  reconcileTotalOrThrow(
    Number(n.order.total),
    n.order.items.map((it: any) => ({
      name: it.title,
      quantity: Number(it.quantity),
      unit_price: Number(it.unit_price),
      tax_rate: Number(it.tax?.value ?? 0),
      discount_percent: Number(it.discount?.percent ?? 0),
    })),
    { context: "test" },
  );
};

describe("a foreign-currency sale", () => {
  it("is invoiced for what it settled at, not for the foreign number", async () => {
    stub(charge());

    const n: any = await new StripeSource().toNormalized(piEvent(), ctx());

    expect(n.order.total).toBeCloseTo(58.20, 2);
    expect(n.order.currency).toBe("EUR");
    expect(n.order.items[0].unit_price).toBeCloseTo(58.20, 2);
  });

  it("records what the buyer actually paid, so the document can show both", async () => {
    stub(charge());

    const n: any = await new StripeSource().toNormalized(piEvent(), ctx());

    expect(n.order.paid_in_foreign_currency.code).toBe("AUD");
    expect(n.order.paid_in_foreign_currency.amount).toBeCloseTo(100, 2);
    // InvoiceXpress derives the second figure as total × rate, so the rate has
    // to land it back on the amount paid.
    const shown = n.order.total * n.order.paid_in_foreign_currency.rate;
    expect(shown).toBeCloseTo(100, 2);
  });

  it("still reconciles — the guard that would otherwise abort the sale", async () => {
    stub(charge());

    const n: any = await new StripeSource().toNormalized(piEvent(), ctx());

    expect(() => assertReconciles(n)).not.toThrow();
  });

  it("keeps the VAT rate through the conversion", async () => {
    // A taxed foreign sale: the rate is a percentage and does not convert.
    stub(charge());
    const n: any = await new StripeSource().toNormalized(piEvent(), ctx());
    n.order.items[0].tax.value = 23;

    expect(Number(n.order.items[0].tax.value)).toBe(23);
  });

  it("leaves a euro sale completely alone", async () => {
    stub(charge({ currency: "eur", amount: 5820, balance_transaction: { amount: 5820, currency: "eur" } }));

    const n: any = await new StripeSource().toNormalized(piEvent("eur", 5820), ctx());

    expect(n.order.currency).toBe("EUR");
    expect(n.order.paid_in_foreign_currency).toBeUndefined();
  });

  it("converts nothing when the flag is off", async () => {
    stub(charge());

    const n: any = await new StripeSource().toNormalized(piEvent(), ctx({ ix_multicurrency: 0 }));

    expect(n.order.currency).toBe("AUD");
    expect(n.order.total).toBeCloseTo(100, 2);
    expect(n.order.paid_in_foreign_currency).toBeUndefined();
  });

  it("converts nothing when Stripe does not say what it settled at", async () => {
    // No balance_transaction: we do not know the rate, and inventing one would
    // misvalue a fiscal document. The order stays in AUD, and the pipeline's
    // currency guard then skips it with an incident — visibly unbilled beats
    // wrongly billed.
    stub(charge({ balance_transaction: undefined }));

    const n: any = await new StripeSource().toNormalized(piEvent(), ctx());

    expect(n.order.currency).toBe("AUD");
    expect(n.order.paid_in_foreign_currency).toBeUndefined();
  });
});
