import type Stripe from "stripe";
import { getStripe } from "./stripe";
import type { Lang } from "./user-language";

/**
 * Stripe writes to our clients too, and in its own language.
 *
 * The receipts, the "your card is about to expire" notices, the hosted invoice
 * page and the customer portal are all rendered by Stripe from
 * `customer.preferred_locales` — so a client marked English who never hears a
 * Portuguese word from us still gets a Portuguese receipt unless this is kept in
 * step with `users.language`.
 *
 * Pushed on every change of the setting rather than read at send time, because
 * the send is Stripe's and we are not there for it.
 */

/** What Stripe's hosted pages take (`locale` on a Checkout or portal session). */
export function stripePageLocale(language: Lang): "en" | "pt" {
    return language === "en" ? "en" : "pt";
}

/** What a Customer carries (`preferred_locales`), which is what Stripe's own
 *  emails are written in. */
export function stripePreferredLocales(language: Lang): string[] {
    return language === "en" ? ["en"] : ["pt-PT"];
}

/**
 * Best effort, always. A client who changed their language and got a 200 must
 * not be told it failed because Stripe was slow, and the next change will push
 * it again; the worst case is one receipt in the old language.
 */
export async function syncStripeCustomerLocale(
    stripe: Stripe,
    customerId: string | null | undefined,
    language: Lang,
): Promise<boolean> {
    if (!customerId) return false;
    try {
        await stripe.customers.update(customerId, { preferred_locales: stripePreferredLocales(language) });
        return true;
    } catch (e: any) {
        console.warn("[stripe-locale] could not update preferred_locales:", e?.message ?? e);
        return false;
    }
}

/**
 * Every Stripe customer this account pays through — a card is a connection, so
 * an account can hold more than one — put on the same language.
 *
 * Called from the two places the setting is written: the client's own Conta page
 * and the operator's customer record. Never throws.
 */
export async function syncAccountStripeLocale(
    db: D1Database,
    accountId: string,
    language: Lang,
): Promise<number> {
    try {
        const rows: any = await db.prepare(
            "SELECT DISTINCT stripe_customer_id FROM subscriptions WHERE user_id = ? AND stripe_customer_id IS NOT NULL"
        ).bind(accountId).all();
        const ids: string[] = (rows?.results ?? []).map((r: any) => r.stripe_customer_id).filter(Boolean);
        if (ids.length === 0) return 0;

        const stripe = getStripe();
        let done = 0;
        for (const id of ids) {
            if (await syncStripeCustomerLocale(stripe, id, language)) done++;
        }
        return done;
    } catch (e: any) {
        console.warn("[stripe-locale] could not reach the customers for", accountId, e?.message ?? e);
        return 0;
    }
}
