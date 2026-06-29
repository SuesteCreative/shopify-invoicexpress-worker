// Thin wrapper around the Stripe REST API. Centralizes auth + version headers
// and the Connect `Stripe-Account` header so callers can't drift on it.
//
// Stripe Connect, direct charges: the Charge / Customer / PaymentIntent /
// Checkout Session objects live on the *connected* account, not the platform.
// A platform key alone returns "no such ..." — every read must carry
// `Stripe-Account: <acct_…>` to be scoped to that account.
// https://docs.stripe.com/connect/authentication
// https://docs.stripe.com/connect/direct-charges

const STRIPE_API_BASE = "https://api.stripe.com/v1";
const STRIPE_API_VERSION = "2024-12-18.acacia";

export interface StripeFetchOpts {
  /** Connected account id (acct_…). When set, sent as the Stripe-Account header. */
  stripeAccount?: string | null;
  /** Extra query params appended to the path. */
  query?: URLSearchParams;
}

/**
 * Fetch a Stripe REST path. `path` is relative to /v1 (e.g. "charges/ch_123").
 * Returns the raw Response — callers handle status/body.
 */
export function stripeFetch(path: string, restrictedKey: string, opts: StripeFetchOpts = {}): Promise<Response> {
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${restrictedKey}`,
    "Stripe-Version": STRIPE_API_VERSION,
  };
  if (opts.stripeAccount) headers["Stripe-Account"] = opts.stripeAccount;

  const qs = opts.query ? `?${opts.query.toString()}` : "";
  return fetch(`${STRIPE_API_BASE}/${path}${qs}`, { headers });
}
