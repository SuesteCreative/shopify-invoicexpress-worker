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

/**
 * Succeeded PaymentIntents created in a window.
 *
 * Filtered client-side because Stripe's PI list endpoint has no status filter —
 * so this pages through everything created in the range and keeps the ones that
 * went through.
 */
export async function listStripePaymentIntents(
  restrictedKey: string,
  fromIso: string,
  toIso: string,
  limit = 500,
  stripeAccount?: string | null,
): Promise<any[]> {
  const fromUnix = Math.floor(new Date(fromIso).getTime() / 1000);
  const toUnix = Math.floor(new Date(toIso).getTime() / 1000);
  const out: any[] = [];
  let startingAfter: string | null = null;

  while (out.length < limit) {
    const params = new URLSearchParams();
    params.set("created[gte]", String(fromUnix));
    params.set("created[lte]", String(toUnix));
    params.set("limit", "100");
    if (startingAfter) params.set("starting_after", startingAfter);

    const res = await stripeFetch("payment_intents", restrictedKey, { stripeAccount, query: params });
    if (!res.ok) {
      throw new Error(`Stripe paymentIntents.list ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const body: any = await res.json();
    const page: any[] = body.data ?? [];
    for (const pi of page) {
      if (pi.status === "succeeded") out.push(pi);
    }
    if (!body.has_more || page.length === 0) break;
    startingAfter = page[page.length - 1]?.id ?? null;
    if (!startingAfter) break;
  }
  return out;
}

/**
 * Fetch one Stripe object by id and wrap it in the event envelope the pipeline
 * expects, so a recovery run and a live webhook take the exact same path.
 */
export async function fetchStripeObject(
  restrictedKey: string,
  stripeId: string,
  stripeAccount?: string | null,
): Promise<{ event: any } | { error: string }> {
  const prefix = stripeId.split("_")[0];
  let path: string;
  let eventType: string;
  switch (prefix) {
    case "pi": path = `payment_intents/${encodeURIComponent(stripeId)}`; eventType = "payment_intent.succeeded"; break;
    case "ch": path = `charges/${encodeURIComponent(stripeId)}`; eventType = "charge.succeeded"; break;
    case "cs": path = `checkout/sessions/${encodeURIComponent(stripeId)}`; eventType = "checkout.session.completed"; break;
    case "in": path = `invoices/${encodeURIComponent(stripeId)}`; eventType = "invoice.paid"; break;
    default: return { error: `Unsupported Stripe id prefix: ${prefix}` };
  }

  const res = await stripeFetch(path, restrictedKey, { stripeAccount });
  if (!res.ok) return { error: `Stripe ${path} ${res.status}: ${(await res.text()).slice(0, 200)}` };
  const obj: any = await res.json();
  // Synthesized events carry no `account` field of their own; stamp the connected
  // account id so downstream enrichment scopes its reads correctly.
  return { event: { type: eventType, data: { object: obj }, ...(stripeAccount ? { account: stripeAccount } : {}) } };
}
