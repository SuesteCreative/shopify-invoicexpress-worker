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
 * The PaymentIntent that actually paid a Stripe invoice, or null when no
 * PaymentIntent did.
 *
 * A card-paid invoice and its PaymentIntent are ONE sale and must key onto one
 * id, or the merchant gets two documents for one payment — and on a connection
 * that finalizes, two certified documents, which can only be undone with a
 * credit note. Up to the 2024 API versions the link was right there on the
 * invoice (`payment_intent`). From the 2025 ones it is not on the object at all:
 * it lives in `payments`, which is not expanded by default and never present in
 * a webhook payload. Measured on a live account 04/09/2026, api 2026-05-27:
 * `invoice.paid` for a subscription charge carries no `payment_intent`, no
 * `charge` and no `payments`.
 *
 * The entry to trust is the one that PAID. An invoice settled outside Stripe
 * carries two: the payment record that settled it, and the abandoned
 * PaymentIntent Stripe had created to collect it, now canceled. Keying on the
 * abandoned one would file the sale under a payment that never happened, so
 * only a `paid` entry of type `payment_intent` counts — everything else,
 * including a payment_record, means "no PaymentIntent behind this invoice",
 * which is exactly right for money collected by hand.
 */
export async function resolveInvoicePaymentIntent(
  invoiceId: string,
  restrictedKey: string,
  stripeAccount?: string | null,
): Promise<string | null> {
  const query = new URLSearchParams();
  query.set("expand[]", "payments");
  const res = await stripeFetch(`invoices/${encodeURIComponent(invoiceId)}`, restrictedKey, { stripeAccount, query });
  if (!res.ok) {
    // Deliberately loud. The caller must retry rather than fall back to keying
    // the invoice on its own id: that is the path that duplicates a document.
    throw new Error(`Stripe invoices/${invoiceId} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const inv: any = await res.json();
  return pickInvoicePaymentIntent(inv);
}

/** The picker, split out so it can be tested against real payloads. */
export function pickInvoicePaymentIntent(invoice: any): string | null {
  const direct = invoice?.payment_intent;
  if (direct) return String(typeof direct === "object" ? direct.id : direct);

  const entries = Array.isArray(invoice?.payments?.data) ? invoice.payments.data : [];
  const paid = entries.find((e: any) =>
    (e?.status === "paid" || Number(e?.amount_paid) > 0) && e?.payment?.type === "payment_intent");
  const pi = paid?.payment?.payment_intent;
  return pi ? String(typeof pi === "object" ? pi.id : pi) : null;
}

/**
 * Put that link back on an invoice event, in place, before anything keys on it.
 *
 * `SourceAdapter.externalId` is synchronous by contract, so an event has to
 * arrive at the pipeline already carrying the id it will be keyed by. This is
 * the one call that makes an invoice event and its PaymentIntent event agree.
 */
export async function stampInvoicePaymentIntent(
  event: any,
  restrictedKey: string | null | undefined,
  stripeAccount?: string | null,
): Promise<void> {
  const type = String(event?.type ?? "");
  const obj = event?.data?.object;
  if (!type.startsWith("invoice.") || !obj?.id || !restrictedKey) return;
  if (pickInvoicePaymentIntent(obj)) {
    obj.payment_intent = pickInvoicePaymentIntent(obj);
    return;
  }
  const pi = await resolveInvoicePaymentIntent(String(obj.id), restrictedKey, stripeAccount);
  if (pi) obj.payment_intent = pi;
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
  // An invoice fetched by id has the same hole as one arriving by webhook: the
  // PaymentIntent that paid it is not on the object. Resolve it here so a
  // re-emit keys the sale the same way the live event did.
  if (prefix === "in") {
    const pi = pickInvoicePaymentIntent(obj) ?? await resolveInvoicePaymentIntent(stripeId, restrictedKey, stripeAccount);
    if (pi) obj.payment_intent = pi;
  }
  // Synthesized events carry no `account` field of their own; stamp the connected
  // account id so downstream enrichment scopes its reads correctly.
  return { event: { type: eventType, data: { object: obj }, ...(stripeAccount ? { account: stripeAccount } : {}) } };
}
