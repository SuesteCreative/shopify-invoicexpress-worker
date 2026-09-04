/**
 * One sale, one id — for an invoice paid inside Stripe.
 *
 * A card-paid Stripe invoice fires `invoice.paid` AND `payment_intent.succeeded`
 * for the same money. They only dedup if both key onto the PaymentIntent, and
 * the link that makes that possible is missing from every current payload:
 * measured live on 2026-09-04 against api 2026-05-27, a subscription's
 * `invoice.paid` carries no `payment_intent`, no `charge` and no `payments`.
 *
 * Getting this wrong is not a cosmetic duplicate. On a connection that
 * finalizes, the second document is certified, and a certified document is
 * undone with a credit note, not a delete.
 */

import { describe, it, expect } from "vitest";
import { pickInvoicePaymentIntent } from "./stripe";
import { stripeStableId } from "../adapters/sources/stripe-source";

describe("pickInvoicePaymentIntent", () => {
  it("takes the field directly when the API version still has it", () => {
    expect(pickInvoicePaymentIntent({ id: "in_1", payment_intent: "pi_1" })).toBe("pi_1");
  });

  it("finds it in `payments` on the 2025+ shape", () => {
    // Shape copied from a live subscription invoice.
    const invoice = {
      id: "in_1UAqSMCZ1YKFEZ6p83Fm7Wyn",
      payments: {
        object: "list",
        data: [{
          id: "inpay_1UArTCCZ1YKFEZ6pD31N6qbj",
          amount_paid: 7900,
          status: "paid",
          is_default: true,
          payment: { payment_intent: "pi_3UArTCCZ1YKFEZ6p0JyQfVrE", type: "payment_intent" },
        }],
      },
    };
    expect(pickInvoicePaymentIntent(invoice)).toBe("pi_3UArTCCZ1YKFEZ6p0JyQfVrE");
  });

  it("ignores the PaymentIntent Stripe abandoned when the money came in by hand", () => {
    // An invoice marked as paid outside Stripe carries two entries: the payment
    // record that settled it, and the PaymentIntent that was never paid.
    // Keying on the second files the sale under a payment that never happened.
    const invoice = {
      id: "in_1UBvtOIvYVkiIIWUGJgrHHtK",
      payments: {
        object: "list",
        data: [
          {
            id: "inpay_paid",
            amount_paid: 100,
            status: "paid",
            is_default: true,
            payment: { payment_record: "pr_65VLJtkvozGUsWdBgv041IvYVkiIIWUSie", type: "payment_record" },
          },
          {
            id: "inpay_abandoned",
            amount_paid: null,
            amount_requested: 100,
            status: "open",
            is_default: false,
            payment: { payment_intent: "pi_3UBvuhIvYVkiIIWU46R432H3", type: "payment_intent" },
          },
        ],
      },
    };
    expect(pickInvoicePaymentIntent(invoice)).toBeNull();
  });

  it("says null for an invoice with no payments at all", () => {
    expect(pickInvoicePaymentIntent({ id: "in_2" })).toBeNull();
    expect(pickInvoicePaymentIntent({ id: "in_3", payments: { data: [] } })).toBeNull();
  });
});

describe("the id a stamped invoice event is keyed by", () => {
  it("collapses onto the PaymentIntent once the link is stamped", () => {
    const event = { type: "invoice.paid", data: { object: { id: "in_1", payment_intent: "pi_1" } } };
    expect(stripeStableId(event)).toBe("pi_1");
  });

  it("keeps the invoice id when no PaymentIntent paid it", () => {
    const event = { type: "invoice.paid", data: { object: { id: "in_1" } } };
    expect(stripeStableId(event)).toBe("in_1");
  });
});
