import { describe, it, expect, vi, afterEach } from "vitest";
import { StripeSource } from "./stripe-source";
import type { AdapterCtx } from "../types";

// A PaymentIntent carries no product, so the line falls back to `pi.description`
// — Stripe's own wording for why the charge happened. Bestisafil's buyers were
// therefore about to read "Subscription update" where their previous documents
// said "Box de 2,5 m²": the merchant's words are one hop away, on the Product
// behind the Stripe invoice line, and the previous integrator read them.
const PRODUCT = {
  id: "prod_UTmy1C07g7VaHr",
  name: "Box de 2,5 m²",
  description: "Uma box de 2,5 m² guarda o conteúdo de um armário grande, caixas e arquivo de escritório.",
};

const piEvent = () => ({
  type: "payment_intent.succeeded",
  data: {
    object: {
      id: "pi_3UFOJaBTTqGjulMG0X7Bqdzi",
      status: "succeeded",
      amount: 8000,
      amount_received: 8000,
      currency: "eur",
      created: 1_789_311_852,
      customer: "cus_UhGVbDgzeAN3kd",
      invoice: "in_1UFNMvBTTqGjulMGmverAKjB",
      description: "Subscription update",
    },
  },
});

const ctxWith = (extra: Record<string, unknown> = {}) => ({
  sourceConfig: { restricted_key: "rk_live_test" },
  config: { stripe_line_names_from_product: 1, ...extra },
} as unknown as AdapterCtx);

/** Customer expand, latest_charge expand, and the invoice behind the payment. */
function stubStripe(lines: any[]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = String(url);
    const body = u.includes("/customers/")
      ? { id: "cus_UhGVbDgzeAN3kd", name: "Virgínia Braz", tax_ids: { data: [] } }
      : u.includes("/invoices/")
        ? { id: "in_1UFNMvBTTqGjulMGmverAKjB", total: 8000, lines: { data: lines } }
        : { latest_charge: { billing_details: { name: null }, created: 1_789_311_852 } };
    return { ok: true, json: async () => body } as unknown as Response;
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe("the merchant's own name for what was sold", () => {
  const oneLine = [{ amount: 8000, description: "1 × Box de 2,5 m² (at €80.00 / month)", price: { product: PRODUCT } }];

  it("titles the line from the Stripe product, not from pi.description", async () => {
    stubStripe(oneLine);
    const n = (await new StripeSource().toNormalized(piEvent(), ctxWith()))!;

    expect(n.order.items?.[0].title).toBe("Box de 2,5 m²");
    // Words only: the money the payment stated is untouched.
    expect(n.order.total).toBe(80);
    expect(n.order.items?.[0].unit_price).toBe(80);
    // And the line stays traceable to the payment that produced it.
    expect(n.order.items?.[0].sku).toBe("pi_3UFOJaBTTqGjulMG0X7Bqdzi");
  });

  it("leaves the line alone for a connection that did not declare the flag", async () => {
    stubStripe(oneLine);
    const n = (await new StripeSource().toNormalized(piEvent(), { sourceConfig: { restricted_key: "rk_live_test" } } as unknown as AdapterCtx))!;

    expect(n.order.items?.[0].title).toBe("Subscription update");
  });

  // The guard that keeps this from becoming a money bug: a product name is only
  // borrowed when the one line agrees with what was actually paid.
  it("refuses a product name when the invoice line disagrees with the payment", async () => {
    stubStripe([{ amount: 12000, price: { product: PRODUCT } }]);
    const n = (await new StripeSource().toNormalized(piEvent(), ctxWith()))!;

    expect(n.order.items?.[0].title).toBe("Subscription update");
  });

  // ponytail's stated ceiling, pinned so it fails loudly if someone widens it
  // without widening the amounts too.
  it("leaves a multi-line invoice alone", async () => {
    stubStripe([
      { amount: 5000, price: { product: PRODUCT } },
      { amount: 3000, price: { product: { ...PRODUCT, name: "Seguro" } } },
    ]);
    const n = (await new StripeSource().toNormalized(piEvent(), ctxWith()))!;

    expect(n.order.items?.[0].title).toBe("Subscription update");
  });
});
