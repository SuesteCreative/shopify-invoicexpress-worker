import { describe, it, expect } from "vitest";
import { stripeToNormalized } from "./stripe-source";

/**
 * What the merchant's customer reads on the invoice line.
 *
 * One Stripe sale arrives as up to three events — Checkout Session,
 * PaymentIntent, Charge — and each used to name the line after ITS OWN id, in
 * its own words: "Stripe checkout cs_…", "Stripe payment pi_…", "Stripe charge
 * ch_…". Whichever event won the race decided what went on the document, so two
 * consecutive sales of the same thing could be described three different ways.
 * Observed live on 10/09/2026 across three documents issued minutes apart.
 *
 * The PaymentIntent is the one identifier every shape agrees on, and it is
 * already what the dedup and the document reference use.
 */

const PI_ID = "pi_3UE5NdE1Z0prp1hi0ETSsmYL";

const titleOf = (event: any): string | undefined =>
    stripeToNormalized(event)?.order.items?.[0]?.title;

describe("the invoice line names the sale after its PaymentIntent", () => {
    it("names a charge after the payment, not after the charge id", () => {
        // The charge id (ch_… or py_… for non-card methods) is an implementation
        // detail of how the money moved. It is not the sale.
        const title = titleOf({
            type: "charge.succeeded",
            data: {
                object: {
                    id: "py_3UE2joE1Z0prp1hi0WRja3ww",
                    object: "charge",
                    payment_intent: PI_ID,
                    amount: 1200,
                    currency: "eur",
                    status: "succeeded",
                    created: 1_760_000_000,
                },
            },
        });
        expect(title).toBe(`Stripe payment ${PI_ID}`);
    });

    it("names a PaymentIntent the same way", () => {
        const title = titleOf({
            type: "payment_intent.succeeded",
            data: {
                object: {
                    id: PI_ID,
                    object: "payment_intent",
                    amount: 1200,
                    currency: "eur",
                    status: "succeeded",
                    created: 1_760_000_000,
                },
            },
        });
        expect(title).toBe(`Stripe payment ${PI_ID}`);
    });

    it("still prefers what the merchant wrote on the sale", () => {
        // A description the merchant set is a real product name and outranks any
        // identifier we could invent.
        const title = titleOf({
            type: "charge.succeeded",
            data: {
                object: {
                    id: "ch_1",
                    object: "charge",
                    payment_intent: PI_ID,
                    description: "Nascente — Chapéu 31",
                    amount: 1200,
                    currency: "eur",
                    status: "succeeded",
                    created: 1_760_000_000,
                },
            },
        });
        expect(title).toBe("Nascente — Chapéu 31");
    });

    it("falls back to the object's own id when there is no PaymentIntent", () => {
        // A charge with no PI still has to be named something.
        const title = titleOf({
            type: "charge.succeeded",
            data: {
                object: {
                    id: "ch_orphan",
                    object: "charge",
                    amount: 1200,
                    currency: "eur",
                    status: "succeeded",
                    created: 1_760_000_000,
                },
            },
        });
        expect(title).toBe("Stripe payment ch_orphan");
    });
});
