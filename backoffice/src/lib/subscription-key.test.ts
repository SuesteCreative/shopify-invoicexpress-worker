import { describe, it, expect } from "vitest";
import { dbTimeMs, shopIsOldest, keyFromRequest, DEFAULT_CONNECTION_KEY } from "./subscription-key";

/**
 * The bug this pins, in full: D1 holds two timestamp formats, and comparing
 * them as strings is wrong in a way that always favours the same answer.
 *
 * Wim Hof Method, 08/09/2026 — Stripe connection created at 14:49:59.950Z,
 * `integrations` row written by SQLite's CURRENT_TIMESTAMP at 14:52:25, two and
 * a half minutes LATER. `'2026-09-08 14:52:25' <= '2026-09-08T14:49:59.950Z'`
 * is true, because ' ' (0x20) sorts before 'T' (0x54) — so migration 0044 read
 * the shop as the older integration and attached the subscription to it. The
 * subscription had been bought for the Stripe connection.
 */
describe("dbTimeMs", () => {
  it("reads both formats D1 actually holds", () => {
    expect(dbTimeMs("2026-09-08T14:49:59.950Z")).toBe(Date.parse("2026-09-08T14:49:59.950Z"));
    expect(dbTimeMs("2026-09-08 14:52:25")).toBe(Date.parse("2026-09-08T14:52:25Z"));
  });

  it("treats a bare timestamp as UTC, which is what CURRENT_TIMESTAMP means", () => {
    // Read as local time this would drift by the offset, and change twice a year.
    expect(dbTimeMs("2026-09-08 14:52:25")).toBe(dbTimeMs("2026-09-08T14:52:25Z"));
  });

  it("keeps an explicit offset", () => {
    expect(dbTimeMs("2026-09-08T15:52:25+01:00")).toBe(Date.parse("2026-09-08T14:52:25Z"));
  });

  it("answers null for nothing and for nonsense", () => {
    expect(dbTimeMs(null)).toBeNull();
    expect(dbTimeMs("")).toBeNull();
    expect(dbTimeMs("not a date")).toBeNull();
  });
});

describe("shopIsOldest", () => {
  it("says no for the case string comparison got wrong", () => {
    expect(shopIsOldest("2026-09-08 14:52:25", "2026-09-08T14:49:59.950Z")).toBe(false);
    // ...which is what a raw string compare claimed:
    expect("2026-09-08 14:52:25" <= "2026-09-08T14:49:59.950Z").toBe(true);
  });

  it("says yes when the shop really is older", () => {
    expect(shopIsOldest("2026-03-01 09:01:29", "2026-05-18T17:00:41.000Z")).toBe(true);
  });

  it("prefers a connection with a real date over a shop with none", () => {
    expect(shopIsOldest(null, "2026-05-18T17:00:41.000Z")).toBe(false);
    expect(shopIsOldest("not a date", "2026-05-18T17:00:41.000Z")).toBe(false);
  });

  it("keeps the shop when there is no connection to compare against", () => {
    expect(shopIsOldest("2026-03-01 09:01:29", null)).toBe(true);
  });
});

describe("keyFromRequest", () => {
  it("takes an explicit key over the page it came from", () => {
    expect(keyFromRequest("stripe:invoicexpress", "faturacao")).toBe("stripe:invoicexpress");
  });

  it("falls back to the page, then to the default", () => {
    expect(keyFromRequest(null, "stripe-ix")).toBe("stripe:invoicexpress");
    expect(keyFromRequest(null, "nonsense")).toBe(DEFAULT_CONNECTION_KEY);
  });
});
