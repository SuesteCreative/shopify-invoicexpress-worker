import type Stripe from "stripe";
import { getStripe, getStripeEnvOptional } from "./stripe";

/**
 * Extra-user seats.
 *
 * An account includes one user (the owner). Every invited member is a one-off
 * charge — €1.50 + IVA, billed the moment the invite is sent — not a recurring
 * subscription item. That is deliberate: it keeps seats off the base plan, so a
 * monthly and an annual account are billed identically and Stripe never has to
 * mix billing intervals on one subscription.
 *
 * The charge is a standalone Stripe invoice against the card already on file,
 * finalized and paid immediately. It lands in the account's billing history
 * through the ordinary `invoice.paid` webhook.
 */

/** Price id / lookup key created in Stripe ("Extra user Rioko 2.0"). */
export const SEAT_PRICE_LOOKUP = "extra_user_rioko2";

export interface SeatPrice {
    id: string;
    unit_amount: number;
    currency: string;
    /** Non-null when the price was created as recurring — we then bill by
     *  amount rather than by price reference (a recurring price cannot sit on a
     *  standalone invoice item). */
    recurring: unknown | null;
}

export async function resolveSeatPrice(): Promise<SeatPrice> {
    const stripe = getStripe();
    const lookup = getStripeEnvOptional("STRIPE_PRICE_EXTRA_USER") || SEAT_PRICE_LOOKUP;

    let price: any = null;
    try {
        price = await stripe.prices.retrieve(lookup);
    } catch {
        const list = await stripe.prices.list({ lookup_keys: [lookup], limit: 1, active: true });
        price = list.data[0];
    }
    if (!price) throw new Error(`Extra-user price not found: ${lookup}`);
    if (!price.active) throw new Error(`Extra-user price ${price.id} is inactive`);
    if (price.currency !== "eur") throw new Error(`Extra-user price ${price.id} must be EUR (got ${price.currency})`);

    return {
        id: price.id,
        unit_amount: price.unit_amount ?? 0,
        currency: price.currency,
        recurring: price.recurring ?? null,
    };
}

export interface SeatCheckout {
    url: string;
    session_id: string;
}

/**
 * A Checkout session for one seat.
 *
 * Deliberately NOT a silent charge against the card on file: unlocking a seat is
 * a purchase the merchant makes on purpose, so they see the price, the VAT and
 * the card they are using, and Stripe hands them a receipt. The seat is granted
 * when the session is paid — by the webhook, and by the confirm call the browser
 * makes when it comes back, whichever lands first.
 */
export async function createSeatCheckout(params: {
    accountId: string;
    customerId: string | null;
    email: string | null;
    origin: string;
    locale: string;
}): Promise<SeatCheckout> {
    const stripe = getStripe();
    const price = await resolveSeatPrice();
    const taxRateId = getStripeEnvOptional("STRIPE_TAX_RATE_ID");
    const returnTo = `${params.origin}/${params.locale}/users`;

    const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [{
            price: price.id,
            quantity: 1,
            ...(taxRateId ? { tax_rates: [taxRateId] } : {}),
        }],
        ...(params.customerId
            ? { customer: params.customerId }
            : { customer_email: params.email ?? undefined, customer_creation: "always" as const }),
        // Fixed 23% PT VAT, exactly as the subscription checkout does.
        ...(taxRateId ? {} : { automatic_tax: { enabled: true } }),
        client_reference_id: params.accountId,
        metadata: {
            app: "rioko",
            kind: "extra_user_seat",
            user_id: params.accountId,
        },
        payment_intent_data: {
            description: "Rioko — utilizador extra",
            metadata: {
                app: "rioko",
                kind: "extra_user_seat",
                user_id: params.accountId,
            },
        },
        success_url: `${returnTo}?seat=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${returnTo}?seat=cancel`,
    });

    if (!session.url) throw new Error("Stripe returned a checkout session with no URL");
    return { url: session.url, session_id: session.id };
}

/** Record a seat for a paid Checkout session. Keyed on the session id, so the
 *  webhook and the browser coming back cannot grant two seats for one payment. */
export async function grantSeatFromSession(
    db: D1Database,
    session: { id: string; metadata?: Record<string, string> | null; amount_total?: number | null; payment_intent?: unknown; client_reference_id?: string | null },
): Promise<{ granted: boolean; accountId: string | null }> {
    const accountId = (session.metadata?.user_id as string) || session.client_reference_id || null;
    if (!accountId) return { granted: false, accountId: null };

    const paymentIntentId = typeof session.payment_intent === "string"
        ? session.payment_intent
        : (session.payment_intent as { id?: string } | null)?.id ?? null;

    const res = await db
        .prepare(`INSERT OR IGNORE INTO account_seats (id, account_id, stripe_invoice_id, amount_cents, purchased_by)
                  VALUES (?, ?, ?, ?, ?)`)
        .bind(`cs-${session.id}`, accountId, paymentIntentId, session.amount_total ?? null, accountId)
        .run();

    return { granted: (res.meta?.changes ?? 0) > 0, accountId };
}
