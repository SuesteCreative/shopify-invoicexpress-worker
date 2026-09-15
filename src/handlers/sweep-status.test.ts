import { describe, it, expect } from "vitest";
import { sweepStatusFor, countsAsCompletion, isStarved } from "./reconciliation-sweep";

/**
 * `sweep_state.last_completed_at` is the clock `reportStarvedShops` watches, so
 * what may stamp it is a correctness question, not bookkeeping.
 *
 * The per-shop cap made "drained 25 of 141" a normal outcome. Calling that `ok`
 * would stamp the clock every night, and a shop that is permanently a quarter
 * drained would read as healthy forever — the same shape as the bug that let Zoo
 * de Lagos go five days unnoticed, arriving from the other direction.
 */
describe("sweepStatusFor", () => {
  it("is ok only when nothing failed and nothing was left behind", () => {
    expect(sweepStatusFor({ errors: 0, deferred: 0 })).toBe("ok");
  });

  it("is partial when the cap or the budget left work for tomorrow", () => {
    expect(sweepStatusFor({ errors: 0, deferred: 116 })).toBe("partial");
    expect(sweepStatusFor({ errors: 0, deferred: 1 })).toBe("partial");
  });

  it("reports an error even when work was also deferred", () => {
    // An error needs a human either way; the remainder returns on its own.
    expect(sweepStatusFor({ errors: 1, deferred: 116 })).toBe("error");
  });
});

describe("countsAsCompletion", () => {
  it("counts a pass that saw the whole shop, including one that failed", () => {
    expect(countsAsCompletion("ok")).toBe(true);
    expect(countsAsCompletion("error")).toBe(true);
  });

  it("refuses everything that left the shop half-seen", () => {
    // Each of these must keep the shop ageing towards the starvation alert.
    expect(countsAsCompletion("partial")).toBe(false);
    expect(countsAsCompletion("skipped_budget")).toBe(false);
    expect(countsAsCompletion("skipped_no_subscription")).toBe(false);
  });
});

describe("isStarved", () => {
  // 15/09/2026: every starvation alarm in the fleet was a shop the paywall skips.
  const cutoff = "2026-09-13T04:00:00.000Z";

  it("never flags a shop the paywall is skipping", () => {
    expect(isStarved("2026-09-10T04:02:55.231Z", "skipped_no_subscription", cutoff)).toBe(false);
    expect(isStarved(null, "skipped_no_subscription", cutoff)).toBe(false);
  });

  it("still flags a shop the budget or the cap keeps from finishing", () => {
    expect(isStarved("2026-09-10T04:02:55.231Z", "skipped_budget", cutoff)).toBe(true);
    expect(isStarved(null, "partial", cutoff)).toBe(true);
    expect(isStarved("2026-09-15T04:02:00.000Z", "ok", cutoff)).toBe(false);
  });
});
