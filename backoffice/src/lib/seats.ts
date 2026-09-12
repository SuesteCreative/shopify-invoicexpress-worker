import { getStripe, getStripeEnvOptional } from "./stripe";
import { SEAT_PRICE_LOOKUP } from "./price-catalogue";

/**
 * Extra-user seats.
 *
 * An account includes one user (the owner) plus one member at no charge. Beyond
 * that, a seat is unlocked one at a time — €1,50 + IVA, a ONE-OFF payment, not
 * a recurring subscription item. That is deliberate: it keeps seats off the
 * base plan, so a monthly and an annual account are billed identically and
 * Stripe never has to mix billing intervals on one subscription.
 *
 * A seat is capacity, not a person: since migration 0040 the account holds a
 * pool, removing someone frees their seat and the next invite reuses it at no
 * charge. The payment is a Stripe Checkout session the merchant completes
 * themselves, so they see the price, the VAT and the card, and Stripe issues
 * the receipt.
 */

export { SEAT_PRICE_LOOKUP } from "./price-catalogue";

export interface SeatPrice {
    id: string;
    unit_amount: number;
    currency: string;
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
    // Checkout runs in `mode: "payment"` and Stripe refuses a recurring price
    // there. Caught here, where the message says what is wrong with the price,
    // rather than inside the session create, where it does not.
    if (price.recurring) throw new Error(`Extra-user price ${price.id} must be one-off, not recurring`);

    return { id: price.id, unit_amount: price.unit_amount ?? 0, currency: price.currency };
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

/**
 * A seat for an account that is not charged for one.
 *
 * Platform admins are exempt, and until now "exempt" only meant the button was
 * enabled: they were sent to Checkout and charged like anyone else. Migration
 * 0040 already describes this row — `stripe_invoice_id` NULL for a seat granted
 * to an exempt account — it simply had nothing writing it.
 */
export async function grantExemptSeat(db: D1Database, accountId: string): Promise<void> {
    await db
        .prepare(`INSERT OR IGNORE INTO account_seats (id, account_id, stripe_invoice_id, amount_cents, purchased_by)
                  VALUES (?, ?, NULL, 0, ?)`)
        .bind(`exempt-${crypto.randomUUID()}`, accountId, accountId)
        .run();
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
