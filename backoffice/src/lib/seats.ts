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

/** The card Stripe should charge for a one-off seat invoice: the customer's own
 *  default, then the default on any live subscription, then whatever card is
 *  attached to the customer. Returns null when the account has no card at all. */
async function resolveCustomerPaymentMethod(stripe: Stripe, customerId: string): Promise<string | null> {
    try {
        const customer: any = await stripe.customers.retrieve(customerId);
        const fromCustomer = customer?.invoice_settings?.default_payment_method;
        if (fromCustomer) return typeof fromCustomer === "string" ? fromCustomer : fromCustomer.id;
    } catch { /* fall through */ }

    try {
        const subs = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 10 });
        for (const sub of subs.data) {
            if (!["active", "trialing", "past_due"].includes(sub.status)) continue;
            const pm = (sub as any).default_payment_method;
            if (pm) return typeof pm === "string" ? pm : pm.id;
        }
    } catch { /* fall through */ }

    try {
        const pms = await stripe.paymentMethods.list({ customer: customerId, type: "card", limit: 1 });
        if (pms.data[0]) return pms.data[0].id;
    } catch { /* fall through */ }

    return null;
}

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

    // Which card to charge. A merchant who subscribed through Checkout often has
    // the card on the SUBSCRIPTION and nothing set as the customer default, and
    // an invoice with no default payment method cannot be paid ("There is no
    // `default_payment_method` set on this Customer or Invoice"). Look in every
    // place the card can be before giving up.
    const paymentMethodId = await resolveCustomerPaymentMethod(stripe, params.customerId);

    // The invoice is created FIRST and the line is bound to it explicitly.
    // Creating the item as a pending one and hoping the next invoice sweeps it up
    // does not work: `invoices.create` excludes pending items by default, which
    // finalized €0 invoices and handed out free seats while the €1.50 items sat
    // waiting to ambush the merchant's next subscription invoice.
    const draft = await stripe.invoices.create({
        customer: params.customerId,
        collection_method: "charge_automatically",
        auto_advance: false,
        description: `Utilizador extra Rioko${params.memberEmail ? ` — ${params.memberEmail}` : ""}`,
        ...(paymentMethodId ? { default_payment_method: paymentMethodId } : {}),
        metadata,
    });
    const invoiceId = draft.id as string;

    await stripe.invoiceItems.create({
        customer: params.customerId,
        invoice: invoiceId,
        ...(price.recurring
            ? { amount: price.unit_amount, currency: price.currency, description: "Utilizador extra Rioko" }
            : { price: price.id }),
        ...(taxRateId ? { tax_rates: [taxRateId] } : {}),
        metadata,
    } as any);

    const finalized = await stripe.invoices.finalizeInvoice(invoiceId);

    // A seat that costs nothing means the line never landed on the invoice.
    // Refuse it rather than granting the seat for free.
    if ((finalized.total ?? 0) <= 0) {
        try { await stripe.invoices.voidInvoice(invoiceId); } catch { /* leave it for support */ }
        throw new Error("the seat invoice came out empty (no billable line)");
    }

    if (finalized.status === "paid") {
        return { invoice_id: invoiceId, amount_cents: finalized.amount_paid ?? finalized.total ?? 0, status: "paid" };
    }

    try {
        const paid = await stripe.invoices.pay(invoiceId, paymentMethodId ? { payment_method: paymentMethodId } : undefined);
        if (paid.status !== "paid") throw new Error(`Invoice ${paid.id} is ${paid.status}`);
        return { invoice_id: invoiceId, amount_cents: paid.amount_paid ?? 0, status: "paid" };
    } catch (e: any) {
        try { await stripe.invoices.voidInvoice(invoiceId); } catch { /* leave it for support */ }
        throw new Error(e?.message || "Card was declined");
    }
}
