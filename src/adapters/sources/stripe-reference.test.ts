import { describe, it, expect } from "vitest";
import { stripeToNormalized, stripeStableId } from "./stripe-source";
import { documentReference } from "../../services/document-references";

// The reference is the ONLY cross-system idempotency key we have: before issuing
// anything the pipeline asks the destination "do you already hold a document with
// this reference?". So it has to be unique per SALE and identical across every
// event that describes that sale.
//
// It was neither. Stripe payloads carry no order number, so every shape below
// hardcoded `order_number: 0` and the reference came out "Order #0" for every
// payment in the account. Nothing noticed until Moloni gained a findByReference
// check on 2026-08-13, at which point every Stripe payment was discarded as a
// duplicate of the first invoice ever issued (MY VAN, 4 payments, 3.278,95 €).
//
// The dedup key was right the whole time — these tests exist to pin the two
// together so they can never disagree again.

const ref = (event: any): string => {
  const n = stripeToNormalized(event);
  if (!n) throw new Error("event did not normalize");
  return documentReference(n.order);
};

const pi = (id: string) => ({
  id,
  status: "succeeded",
  amount: 63400,
  amount_received: 63400,
  currency: "eur",
  created: 1_755_000_000,
});

describe("Stripe document reference", () => {
  it("is different for different payments", () => {
    const a = ref({ type: "payment_intent.succeeded", data: { object: pi("pi_3U3vtjJNp2FcbLOX1LzfGa73") } });
    const b = ref({ type: "payment_intent.succeeded", data: { object: pi("pi_3U3xcKJNp2FcbLOX02FNxlGY") } });
    expect(a).not.toBe(b);
  });

  it("never collapses to the constant that caused the incident", () => {
    const r = ref({ type: "payment_intent.succeeded", data: { object: pi("pi_3U40sLJNp2FcbLOX0ugByCqC") } });
    expect(r).not.toBe("Order #0");
    expect(r).toContain("pi_3U40sLJNp2FcbLOX0ugByCqC");
  });

  it("matches the dedup key, so the lookup and the write agree", () => {
    const event = { type: "payment_intent.succeeded", data: { object: pi("pi_3U4H6UJNp2FcbLOX16nV1YEj") } };
    expect(ref(event)).toBe(`Order #${stripeStableId(event)}`);
  });

  it("is the same for the charge and the payment intent of one sale", () => {
    // A single card payment fires both. Different references here would mean two
    // documents for one payment.
    const piEvent = { type: "payment_intent.succeeded", data: { object: pi("pi_1") } };
    const chargeEvent = {
      type: "charge.succeeded",
      data: { object: { id: "ch_1", payment_intent: "pi_1", amount: 63400, amount_captured: 63400, currency: "eur", created: 1_755_000_000 } },
    };
    expect(ref(chargeEvent)).toBe(ref(piEvent));
  });

  it("is the same for a checkout session and its payment intent", () => {
    const piEvent = { type: "payment_intent.succeeded", data: { object: pi("pi_2") } };
    const sessionEvent = {
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_2",
          payment_intent: "pi_2",
          payment_status: "paid",
          amount_total: 63400,
          amount_subtotal: 63400,
          currency: "eur",
          created: 1_755_000_000,
          customer_details: {},
        },
      },
    };
    expect(ref(sessionEvent)).toBe(ref(piEvent));
  });

  it("stays unique for a Stripe invoice that has no number yet", () => {
    // `inv.number` is null until Stripe finalizes, which used to degrade the
    // reference to "Order #0" on that shape too.
    const mk = (id: string) => ({
      type: "invoice.paid",
      data: { object: { id, number: null, created: 1_755_000_000, currency: "eur", total: 63400, lines: { data: [] } } },
    });
    expect(ref(mk("in_A"))).not.toBe(ref(mk("in_B")));
    expect(ref(mk("in_A"))).not.toBe("Order #0");
  });
});
