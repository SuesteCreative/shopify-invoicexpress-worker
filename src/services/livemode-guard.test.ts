import { describe, it, expect } from "vitest";
import { livemodeMatches } from "./stripe-auth";

/**
 * A test-mode Stripe event must never become a real fiscal document.
 *
 * `livemode` was written into `source_config_json` by the Connect OAuth callback
 * and read by nothing. An event from Stripe's test mode whose `account` matched
 * an active connection went through to Moloni or InvoiceXpress and was invoiced
 * for real — money that does not exist, on a document that cannot be unmade
 * without a credit note.
 */
describe("livemodeMatches", () => {
  const LIVE = JSON.stringify({ stripe_account_id: "acct_1", livemode: true });
  const TEST = JSON.stringify({ stripe_account_id: "acct_1", livemode: false });
  const SILENT = JSON.stringify({ stripe_account_id: "acct_1" });

  it("lets a live event through to a live connection", () => {
    expect(livemodeMatches(LIVE, true)).toBe(true);
  });

  it("refuses a test event on a live connection", () => {
    expect(livemodeMatches(LIVE, false)).toBe(false);
  });

  it("refuses a test event on a connection that never stated a mode", () => {
    // Closed by default. Every connection predating Connect says nothing, and
    // every one of them is live — so silence must not be an opening.
    expect(livemodeMatches(SILENT, false)).toBe(false);
    expect(livemodeMatches(null, false)).toBe(false);
    expect(livemodeMatches(undefined, false)).toBe(false);
    expect(livemodeMatches("{not json", false)).toBe(false);
  });

  it("lets a test event through to a test connection", () => {
    expect(livemodeMatches(TEST, false)).toBe(true);
  });

  it("refuses a LIVE event on a test connection", () => {
    // The other direction matters too: a sandbox connection must not start
    // invoicing real payments because someone pointed the live endpoint at it.
    expect(livemodeMatches(TEST, true)).toBe(false);
  });

  it("treats an event with no livemode field as live", () => {
    // Stripe always sends it. Its absence means this is not a Stripe event, and
    // the safe reading of that is "not a test".
    expect(livemodeMatches(LIVE, undefined)).toBe(true);
    expect(livemodeMatches(TEST, undefined)).toBe(false);
  });
});
