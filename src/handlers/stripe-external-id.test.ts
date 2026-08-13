import { describe, it, expect } from "vitest";
import { externalIdFromEvent } from "./admin-stripe";

// The id we key work on is the SALE (payment intent), never the Stripe event.
// The DLQ consumer now resolves incidents through this same helper: an incident
// carrying `evt_…` can never be matched against any invoice table, so it nags in
// the weekly digest forever (MY VAN, Aug 2026).

describe("externalIdFromEvent", () => {
  it("resolves a refund to the payment intent, not the charge", () => {
    const event = { id: "evt_1", type: "charge.refunded", data: { object: { id: "ch_1", payment_intent: "pi_1" } } };
    expect(externalIdFromEvent(event)).toBe("pi_1");
  });

  it("resolves a card success to the payment intent", () => {
    const event = { id: "evt_2", type: "charge.succeeded", data: { object: { id: "ch_2", payment_intent: "pi_2" } } };
    expect(externalIdFromEvent(event)).toBe("pi_2");
  });

  it("resolves a checkout session to the payment intent", () => {
    const event = { id: "evt_3", type: "checkout.session.completed", data: { object: { id: "cs_3", payment_intent: "pi_3" } } };
    expect(externalIdFromEvent(event)).toBe("pi_3");
  });

  it("keeps the object id when there is no payment intent to resolve to", () => {
    const event = { id: "evt_4", type: "payment_intent.succeeded", data: { object: { id: "pi_4" } } };
    expect(externalIdFromEvent(event)).toBe("pi_4");
  });

  it("falls back to the event id only when the body carries no object", () => {
    expect(externalIdFromEvent({ id: "evt_5", type: "charge.refunded" })).toBe("evt_5");
  });
});
