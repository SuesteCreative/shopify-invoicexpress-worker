import { describe, it, expect } from "vitest";
import { subscriptionBlocks } from "./suppression-digest";

// Pinned to the same cases as subscription-gate.test.ts: the digest must decide
// "is this merchant standing outside?" exactly as the gate decides "may this
// order through?". If the two ever disagree, the report lies about production.
describe("subscriptionBlocks", () => {
  const now = new Date("2026-09-13T00:00:00Z");
  const future = "2026-12-01T00:00:00Z";
  const past = "2026-08-31T23:59:59Z";

  it("lets an early bird inside its window through", () => {
    expect(subscriptionBlocks({ status: "trialing", has_sub: 0, early_bird: 1, trial_end: future }, now)).toBeNull();
  });

  it("blocks an early bird whose trial has ended", () => {
    expect(subscriptionBlocks({ status: "trialing", has_sub: 0, early_bird: 1, trial_end: past }, now))
      .toBe("trial_expired");
  });

  it("blocks a non-early-bird trial with no Stripe subscription", () => {
    expect(subscriptionBlocks({ status: "trialing", has_sub: 0, early_bird: 0, trial_end: future }, now))
      .toBe("trial_expired");
  });

  it("lets a trial backed by a real Stripe subscription through", () => {
    expect(subscriptionBlocks({ status: "trialing", has_sub: 1, early_bird: 0, trial_end: past }, now)).toBeNull();
  });

  it("lets an active subscription through", () => {
    expect(subscriptionBlocks({ status: "active", has_sub: 1 }, now)).toBeNull();
  });

  it("names the dead statuses", () => {
    for (const status of ["canceled", "unpaid", "past_due", "incomplete", "incomplete_expired"]) {
      expect(subscriptionBlocks({ status, has_sub: 1 }, now)).toBe(status);
    }
  });

  it("treats a missing subscription row as blocked", () => {
    expect(subscriptionBlocks(null, now)).toBe("no_subscription");
  });
});
