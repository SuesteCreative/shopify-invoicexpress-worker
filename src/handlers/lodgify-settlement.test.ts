import { describe, it, expect } from "vitest";
import { shouldAskDestination } from "./lodgify-settlement";
import type { SettlementState } from "../storage";

/**
 * The gate that decides whether a document costs a Moloni round trip.
 *
 * It is the whole cost model — without it the settlement pass re-reads every
 * document a merchant has ever been invoiced for, every half hour, for the two
 * receipts a month it actually issues, and the bill grows with billing HISTORY
 * rather than with payments. It is also the only place a `needs_human` latch is
 * honoured, so a wrong answer here is either a wasted read or a runaway.
 */

const state = (over: Partial<SettlementState> = {}): SettlementState => ({
  bookingId: "22395793",
  invoiceId: "1017247670",
  docStatus: 1,
  docTotal: 669,
  lastCollected: 334.5,
  lastSettled: 334.5,
  lastReceiptId: "1017251368",
  needsHuman: false,
  attempts: 0,
  lastCheckedAt: "2026-09-03T18:00:00.000Z",
  nextCheckAt: null,
  lastMessage: null,
  ...over,
});

const NOW = Date.parse("2026-09-03T20:00:00.000Z");

describe("shouldAskDestination", () => {
  it("asks about a document it has never seen", () => {
    expect(shouldAskDestination(undefined, 334.5, NOW)).toBe(true);
  });

  it("stays quiet when Moloni already covers what came in", () => {
    expect(shouldAskDestination(state(), 334.5, NOW)).toBe(false);
  });

  it("asks the moment the merchant records more money", () => {
    // The event the whole pass exists to react to.
    expect(shouldAskDestination(state(), 669, NOW)).toBe(true);
  });

  it("ignores a cent of drift rather than asking every pass", () => {
    expect(shouldAskDestination(state(), 334.505, NOW)).toBe(false);
  });

  it("never asks again once a human has to look", () => {
    // Set when a Recibo was accepted and the document did not reconcile: asking
    // again is how a second receipt gets issued for the same money.
    expect(shouldAskDestination(state({ needsHuman: true }), 669, NOW)).toBe(false);
    expect(shouldAskDestination(state({ needsHuman: true, lastCollected: null }), 669, NOW)).toBe(false);
  });

  it("re-checks a draft on a cooldown, not on every pass", () => {
    // A draft awaiting the merchant's approval is a deliberate state in this
    // fleet. Asking every 30 minutes would cost 48 reads a day to learn nothing.
    const draft = state({ docStatus: 0, lastSettled: null });
    expect(shouldAskDestination({ ...draft, nextCheckAt: "2026-09-03T23:00:00.000Z" }, 334.5, NOW)).toBe(false);
    expect(shouldAskDestination({ ...draft, nextCheckAt: "2026-09-03T19:00:00.000Z" }, 334.5, NOW)).toBe(true);
    expect(shouldAskDestination({ ...draft, nextCheckAt: null }, 334.5, NOW)).toBe(true);
  });

  it("asks again when a payment is corrected DOWNWARDS", () => {
    // The over-settled guard lives in the destination and can only fire if the
    // document is asked about again. Reacting to increases alone made it
    // unreachable the moment a state row existed: the merchant corrects 334,50 €
    // to 200 €, the Fatura stays settled for 334,50 €, and nobody is told.
    expect(shouldAskDestination(state(), 200, NOW)).toBe(true);
  });

  it("asks when it has a closed document but no settled figure", () => {
    // Nothing cached to reason from — the destination is the authority, so go
    // and ask rather than assume either way.
    expect(shouldAskDestination(state({ lastSettled: null }), 334.5, NOW)).toBe(true);
  });

  it("stops asking once the document is fully settled, whatever else arrives", () => {
    // collected above the document total (an overpayment) must not reopen it:
    // the receipt is bounded by the document, so there is nothing left to issue.
    expect(shouldAskDestination(state({ lastSettled: 669, lastCollected: 800 }), 800, NOW)).toBe(false);
  });
});
