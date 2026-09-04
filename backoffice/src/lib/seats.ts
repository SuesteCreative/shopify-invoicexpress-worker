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

export interface SeatChargeResult {
    invoice_id: string;
    amount_cents: number;
    status: string;
}

/**
 * Bill one seat. Throws with a merchant-readable message when the card is
 * refused — the caller must then NOT hand out the seat. A finalized-but-unpaid
 * invoice is voided so a failed invite leaves nothing collectable behind.
 */
export async function chargeSeat(params: {
    customerId: string;
    accountId: string;
    memberEmail: string;
    memberRowId: string;
}): Promise<SeatChargeResult> {
    const stripe = getStripe();
    const price = await resolveSeatPrice();
    const taxRateId = getStripeEnvOptional("STRIPE_TAX_RATE_ID");
    const metadata = {
        app: "rioko",
        kind: "extra_user_seat",
        user_id: params.accountId,
        member_email: params.memberEmail,
        member_id: params.memberRowId,
    };

    await stripe.invoiceItems.create({
        customer: params.customerId,
        ...(price.recurring
            ? { amount: price.unit_amount, currency: price.currency, description: "Utilizador extra Rioko" }
            : { price: price.id }),
        ...(taxRateId ? { tax_rates: [taxRateId] } : {}),
        metadata,
    } as any);

    const draft = await stripe.invoices.create({
        customer: params.customerId,
        collection_method: "charge_automatically",
        auto_advance: false,
        description: `Utilizador extra Rioko — ${params.memberEmail}`,
        metadata,
    });

    const finalized = await stripe.invoices.finalizeInvoice(draft.id as string);
    if (finalized.status === "paid") {
        return { invoice_id: finalized.id as string, amount_cents: finalized.amount_paid ?? 0, status: "paid" };
    }

    try {
        const paid = await stripe.invoices.pay(finalized.id as string);
        if (paid.status !== "paid") throw new Error(`Invoice ${paid.id} is ${paid.status}`);
        return { invoice_id: paid.id as string, amount_cents: paid.amount_paid ?? 0, status: "paid" };
    } catch (e: any) {
        try { await stripe.invoices.voidInvoice(finalized.id as string); } catch { /* leave it for support */ }
        throw new Error(e?.message || "Card was declined");
    }
}
