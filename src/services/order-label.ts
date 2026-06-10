// Human-friendly labels for an order/payment, extracted from a raw source
// payload (Shopify order webhook, Stripe charge/PI). Used to enrich incident
// emails so an alert names the order (#1234) and the end client, instead of
// only the opaque numeric id. Best-effort and tolerant of missing fields — any
// field we can't find comes back `undefined` and the email simply omits it.

export interface OrderLabel {
  /** Display reference, e.g. "#1234" (Shopify order name). */
  orderRef?: string;
  /** End-customer name on the document, e.g. "João Silva". */
  clientName?: string;
}

function clean(s: unknown): string | undefined {
  const v = String(s ?? "").trim();
  return v.length ? v : undefined;
}

function joinName(first: unknown, last: unknown): string | undefined {
  return clean([clean(first), clean(last)].filter(Boolean).join(" "));
}

/** Shopify uses `name` ("#1234"); fall back to `order_number` / `number`. */
function orderRefFrom(o: any): string | undefined {
  const name = clean(o?.name);
  if (name) return name.startsWith("#") ? name : `#${name}`;
  if (o?.order_number != null) return `#${o.order_number}`;
  if (o?.number != null) return `#${o.number}`;
  return undefined;
}

function clientNameFrom(o: any): string | undefined {
  const ba = o?.billing_address ?? {};
  const sa = o?.shipping_address ?? {};
  const c = o?.customer ?? {};
  return (
    clean(ba.name) ||
    joinName(ba.first_name, ba.last_name) ||
    joinName(c.first_name, c.last_name) ||
    clean(c.name) ||
    joinName(sa.first_name, sa.last_name) ||
    clean(ba.company) ||
    // Stripe-source fallbacks (charge / payment_intent shapes).
    clean(o?.billing_details?.name) ||
    clean(o?.customer_details?.name) ||
    clean(o?.email) ||
    clean(o?.contact_email) ||
    undefined
  );
}

/** Extract `{ orderRef, clientName }` from a raw Shopify/Stripe payload. */
export function describeOrder(raw: any): OrderLabel {
  if (!raw || typeof raw !== "object") return {};
  return { orderRef: orderRefFrom(raw), clientName: clientNameFrom(raw) };
}
