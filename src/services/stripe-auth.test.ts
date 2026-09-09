import { describe, it, expect } from "vitest";
import { resolveStripeAuth, ctxStripeAuth, isConnectConfig } from "./stripe-auth";

/**
 * The whole point of this module is that adding Stripe Connect changed nothing
 * for the merchants already on a restricted key. Most of what is asserted here
 * is therefore about the OLD path staying identical, not about the new one.
 */

const ENV = { STRIPE_PLATFORM_SECRET_KEY: "sk_platform" };

describe("resolveStripeAuth — restricted-key connections", () => {
  it("returns the merchant's own key and NO connect account", () => {
    // connectAccount must stay undefined even though the row stores an
    // account id: the three read helpers in stripe-source use its presence to
    // decide whether to send a Stripe-Account header, and these connections
    // have never sent one.
    const auth = resolveStripeAuth(ENV, {
      restricted_key: "rk_merchant",
      stripe_account_id: "acct_merchant",
    });
    expect(auth).toEqual({ apiKey: "rk_merchant" });
  });

  it("ignores the older stripe_restricted_key spelling, as the worker always has", () => {
    // Read by one backoffice route and by nothing in the worker. Accepting it
    // here would start enriching a connection that gets no enrichment today —
    // an improvement, perhaps, but a change to live invoicing that nobody asked
    // for. Byte-for-byte behaviour is the point of this module.
    expect(resolveStripeAuth(ENV, { stripe_restricted_key: "rk_old" })).toBeNull();
  });

  it("returns null when there is no key, rather than throwing", () => {
    // The nightly heal and reconciliation both treat a credential-less
    // connection as "skip", and a throw would turn an unfinished wizard into a
    // nightly incident.
    expect(resolveStripeAuth(ENV, { stripe_account_id: "acct_x" })).toBeNull();
    expect(resolveStripeAuth(ENV, {})).toBeNull();
    expect(resolveStripeAuth(ENV, null)).toBeNull();
  });

  it("ignores the platform key entirely", () => {
    const auth = resolveStripeAuth({ STRIPE_PLATFORM_SECRET_KEY: "sk_platform" }, { restricted_key: "rk_merchant" });
    expect(auth?.apiKey).toBe("rk_merchant");
  });
});

describe("resolveStripeAuth — Connect connections", () => {
  const CONNECT = { auth_mode: "connect", stripe_account_id: "acct_connected" };

  it("uses the platform key and scopes it to the connected account", () => {
    expect(resolveStripeAuth(ENV, CONNECT)).toEqual({
      apiKey: "sk_platform",
      connectAccount: "acct_connected",
    });
  });

  it("is null when the platform key is missing", () => {
    // Half a credential is not a credential: without the platform key every
    // read would 401, and reporting that as "no connection" is more honest
    // than letting it fail per payment.
    expect(resolveStripeAuth({}, CONNECT)).toBeNull();
  });

  it("is null when the account id is missing", () => {
    expect(resolveStripeAuth(ENV, { auth_mode: "connect" })).toBeNull();
  });

  it("never falls back to a restricted key left on the row", () => {
    // A row that was migrated from the old flow could still carry one. Using it
    // would silently keep calling Stripe as the merchant after they authorised
    // us to do it as the platform.
    const auth = resolveStripeAuth(ENV, { ...CONNECT, restricted_key: "rk_stale" });
    expect(auth?.apiKey).toBe("sk_platform");
  });
});

describe("isConnectConfig", () => {
  it("is true only for the explicit marker", () => {
    expect(isConnectConfig({ auth_mode: "connect" })).toBe(true);
    expect(isConnectConfig({ auth_mode: "password" })).toBe(false);
    expect(isConnectConfig({ stripe_account_id: "acct_1" })).toBe(false);
    expect(isConnectConfig(undefined)).toBe(false);
  });
});

describe("ctxStripeAuth", () => {
  it("prefers what buildAdapterCtx resolved", () => {
    const auth = ctxStripeAuth({
      stripeAuth: { apiKey: "sk_platform", connectAccount: "acct_1" },
      sourceConfig: { restricted_key: "rk_ignored" },
    });
    expect(auth).toEqual({ apiKey: "sk_platform", connectAccount: "acct_1" });
  });

  it("falls back to the restricted key for hand-rolled contexts", () => {
    // Several callers still build a bare { apiKey, config } ctx. They only ever
    // did restricted-key work, so they must keep working unchanged.
    expect(ctxStripeAuth({ sourceConfig: { restricted_key: "rk_merchant" } }))
      .toEqual({ apiKey: "rk_merchant" });
  });

  it("is null when neither is available", () => {
    expect(ctxStripeAuth({})).toBeNull();
  });
});
