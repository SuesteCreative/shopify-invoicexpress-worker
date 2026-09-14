import { describe, it, expect } from "vitest";
import { claimScopeFor } from "./generic-pipeline";

/**
 * One document per sale, for every source whose external id names one sale.
 *
 * A single Stripe payment fires `invoice.paid`, `payment_intent.succeeded` and
 * `charge.succeeded`, all carrying the same PaymentIntent. They dedup on it,
 * but only once a document exists — so three parallel deliveries all read "not
 * processed" and all create.
 *
 * Restricted-key `stripe` connections were excluded from the claim when it was
 * written, on the grounds that their merchants had arranged around the
 * duplicates. Measured on Wim Hof Method, 14/09/2026: two sales, six documents,
 * hours before that connection moved to `stripe_connect` — and by then the
 * connection was finalizing, which turns three drafts to delete into three
 * certified documents and two credit notes.
 */
describe("which sources claim their sale", () => {
  it("claims every source whose external id names one sale", () => {
    for (const source of ["stripe", "stripe_connect", "eupago"]) {
      expect(claimScopeFor(source, "user_abc")).toBe("u:user_abc");
    }
  });

  it("does not claim Lodgify, whose instalments reuse the booking id", () => {
    // Several documents against one booking is what an instalment plan IS. A
    // claim keyed on the booking id would block the second one.
    expect(claimScopeFor("lodgify", "user_abc")).toBeNull();
  });

  it("scopes by user, so two accounts cannot collide on one bucket", () => {
    // Stripe and EuPago connections carry no shop domain, and the claim key is
    // (scope, external_id). Unscoped, every such account shares one bucket.
    expect(claimScopeFor("stripe", "user_a")).not.toBe(claimScopeFor("stripe", "user_b"));
  });

  it("claims nothing when there is no user to scope by", () => {
    expect(claimScopeFor("stripe", null)).toBeNull();
    expect(claimScopeFor("stripe", "")).toBeNull();
  });
});
