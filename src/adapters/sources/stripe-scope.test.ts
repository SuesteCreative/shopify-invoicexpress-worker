/**
 * One Stripe account, two systems invoicing out of it.
 *
 * Escola Lá Fora's own backoffice issues Moloni documents for the sales made
 * through its forms; everything else in the same Stripe account — a Paperform
 * app that has been collecting money since 2025 — has had nobody invoicing it
 * since 08/05/2026. Rioko was brought in for the second stream, and a pipeline
 * that cannot tell them apart mints a duplicate fiscal document for every sale
 * of the first one.
 */
import { describe, it, expect } from "vitest";
import { StripeSource, parseScopeSkipKeys, scopeSkipHit } from "./stripe-source";
import { crossSystemReferences, saleReference } from "../../services/document-references";

const KEYS = ["submission_id"];

describe("parseScopeSkipKeys", () => {
  it("is off when the connection said nothing", () => {
    expect(parseScopeSkipKeys(null)).toEqual([]);
    expect(parseScopeSkipKeys("")).toEqual([]);
    expect(parseScopeSkipKeys("   ")).toEqual([]);
  });

  it("takes a comma-separated list, trimmed", () => {
    expect(parseScopeSkipKeys(" submission_id , booking_ref ")).toEqual(["submission_id", "booking_ref"]);
  });
});

describe("scopeSkipHit", () => {
  it("sees the marker on a PaymentIntent's own metadata", () => {
    expect(scopeSkipHit([{ id: "pi_1", metadata: { submission_id: "abc" } }], KEYS)).toBe("submission_id");
  });

  it("sees the subscription's marker on an invoice (2024 API: subscription_details)", () => {
    const invoice = { id: "in_1", metadata: {}, subscription_details: { metadata: { submission_id: "abc" } } };
    expect(scopeSkipHit([invoice], KEYS)).toBe("submission_id");
  });

  it("sees it after Stripe moved the field (2025 API: parent.subscription_details)", () => {
    // The trap that cost this merchant three months of mensalidades: a webhook
    // arrives in whatever version its endpoint was registered at, and reading
    // only the old spelling finds undefined and carries on in silence.
    const invoice = { id: "in_1", metadata: {}, parent: { subscription_details: { metadata: { submission_id: "abc" } } } };
    expect(scopeSkipHit([invoice], KEYS)).toBe("submission_id");
  });

  it("does not fire on an empty value — a blank key marks nothing", () => {
    expect(scopeSkipHit([{ metadata: { submission_id: "  " } }], KEYS)).toBeNull();
  });

  it("leaves the other stream alone", () => {
    // Paperform's own marker is a DIFFERENT key; these are the sales Rioko owns.
    expect(scopeSkipHit([{ metadata: { pending_submission_id: "6a9ab42c" } }], KEYS)).toBeNull();
  });
});

describe("StripeSource.scopeBlocker", () => {
  const source = new StripeSource();
  const ctx = (skip: string | null) => ({ config: { stripe_scope_skip_metadata: skip } }) as any;

  it("says nothing, and asks Stripe nothing, on a one-stream account", async () => {
    const event = { type: "payment_intent.succeeded", data: { object: { id: "pi_1", metadata: {} } } };
    await expect(source.scopeBlocker(event, ctx(null))).resolves.toBeNull();
  });

  it("refuses a sale the other system marked", async () => {
    const event = { type: "checkout.session.completed", data: { object: { id: "cs_1", metadata: { submission_id: "cmu0" } } } };
    await expect(source.scopeBlocker(event, ctx("submission_id"))).resolves.toMatch(/submission_id/);
  });

  it("keeps a sale the other system did not mark", async () => {
    const event = {
      type: "charge.succeeded",
      data: { object: { id: "ch_1", metadata: { pending_submission_id: "6a9ab42c" } } },
    };
    // No credentials on ctx, so no look-through is attempted and the answer is
    // the event's own: not theirs.
    await expect(source.scopeBlocker(event, ctx("submission_id"))).resolves.toBeNull();
  });
});

describe("crossSystemReferences", () => {
  it("finds the bare payment id the other system files under", () => {
    expect(crossSystemReferences(saleReference("pi_3Tp77GBp3wyQk8MN2nx5PfwL")))
      .toEqual(["pi_3Tp77GBp3wyQk8MN2nx5PfwL", "#stripe_pi_3Tp77GBp3wyQk8MN2nx5PfwL"]);
  });

  it("refuses to guess from a bare order number", () => {
    // `1137` would match another sale's document, and `Order #1137` would match
    // the document written for `Order #1137-2`.
    expect(crossSystemReferences(saleReference(1137))).toEqual([]);
    expect(crossSystemReferences("Order #1137-2")).toEqual([]);
  });

  it("leaves credit-note and cancel references alone", () => {
    expect(crossSystemReferences("OrderRefund #re_1abc")).toEqual([]);
    expect(crossSystemReferences("OrderCancel #pi_1abc")).toEqual([]);
  });
});
