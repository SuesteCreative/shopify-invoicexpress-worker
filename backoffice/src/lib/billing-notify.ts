import Stripe from "stripe";
import { accountLabel } from "./labels";
import { callWorkerJson } from "./worker";

/**
 * The client-facing side of a failed subscription charge.
 *
 * Stripe retries a failed subscription invoice on its own schedule and then
 * gives up, and nothing about that reaches the merchant unless we tell them:
 * the dashboard shows the failure to us, not to them. This sends the one email
 * that can fix it — the Stripe link that replaces the card — on every distinct
 * `invoice.payment_failed` event, so each retry that fails is one nudge, and a
 * Stripe webhook re-delivery of the same event is none (the caller only invokes
 * this when the event id was new to `billing_events`).
 *
 * Best effort by construction: a failure here must never fail the webhook, or
 * Stripe re-delivers an event we already recorded.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function uniqueEmails(...candidates: Array<string | null | undefined>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of candidates) {
        const addr = typeof c === "string" ? c.trim() : "";
        if (!EMAIL_RE.test(addr)) continue;
        const key = addr.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(addr);
    }
    return out;
}

function moneyLabel(amountCents: number, currency: string | null | undefined): string {
    try {
        return new Intl.NumberFormat("pt-PT", {
            style: "currency",
            currency: (currency || "eur").toUpperCase(),
        }).format(amountCents / 100);
    } catch {
        return `${(amountCents / 100).toFixed(2)} ${(currency || "eur").toUpperCase()}`;
    }
}

function dateLabel(unix: number | null | undefined): string | undefined {
    if (!unix) return undefined;
    try {
        return new Intl.DateTimeFormat("pt-PT", {
            day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Lisbon",
        }).format(new Date(unix * 1000));
    } catch {
        return undefined;
    }
}

function customerIdOf(customer: Stripe.Invoice["customer"]): string | null {
    if (!customer) return null;
    return typeof customer === "string" ? customer : customer.id;
}

/**
 * Mint the link the email is built around: Stripe's portal in its
 * `payment_method_update` flow, which drops the client straight on the card
 * form. It needs the Customer Portal configured in the Stripe dashboard and the
 * session link does not live forever, so the hosted invoice page — durable, and
 * it also takes a new card — is the fallback rather than an empty email.
 */
async function paymentUpdateLink(
    stripe: Stripe,
    customerId: string | null,
    returnUrl: string,
): Promise<string | null> {
    if (!customerId) return null;
    try {
        const session = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: returnUrl,
            flow_data: { type: "payment_method_update" },
        });
        return session.url ?? null;
    } catch (e: any) {
        console.error("[billing-notify] portal session failed:", e?.message ?? e);
        return null;
    }
}

export interface PaymentFailedNotifyResult {
    sent: boolean;
    /** Why nothing was sent, for the webhook log. */
    reason?: string;
    recipients?: string[];
}

export async function notifySubscriptionPaymentFailed(opts: {
    db: D1Database;
    stripe: Stripe;
    userId: string;
    invoice: Stripe.Invoice;
    /** Origin of the app, used for the portal return URL and the email's links. */
    origin: string;
}): Promise<PaymentFailedNotifyResult> {
    const { db, stripe, userId, invoice, origin } = opts;

    // One-off payments fail too, and they are not what this email says. Only a
    // subscription invoice carries the "your access continues" promise below.
    const subscriptionId = typeof invoice.subscription === "string"
        ? invoice.subscription
        : invoice.subscription?.id ?? null;
    if (!subscriptionId) return { sent: false, reason: "not_a_subscription_invoice" };

    const amountDue = invoice.amount_due ?? 0;
    if (amountDue <= 0) return { sent: false, reason: "nothing_due" };

    const subRow: any = await db.prepare(
        "SELECT email, stripe_customer_id FROM subscriptions WHERE user_id = ?"
    ).bind(userId).first();
    const userRow: any = await db.prepare(
        "SELECT id, email, name, company_name, admin_label FROM users WHERE id = ?"
    ).bind(userId).first();

    // Every address we hold for this client. They are the same company; the
    // billing contact and the login are routinely different people, and the one
    // who can change the card is whichever of them opens the email first.
    const to = uniqueEmails(subRow?.email, invoice.customer_email, userRow?.email);
    if (to.length === 0) return { sent: false, reason: "no_recipient" };

    const returnUrl = `${origin.replace(/\/$/, "")}/faturacao`;
    const updateUrl = await paymentUpdateLink(
        stripe,
        customerIdOf(invoice.customer) ?? subRow?.stripe_customer_id ?? null,
        returnUrl,
    ) ?? invoice.hosted_invoice_url ?? null;
    if (!updateUrl) return { sent: false, reason: "no_payment_link" };

    const { ok, status, data } = await callWorkerJson("/admin/payment-failed-email", {
        method: "POST",
        body: JSON.stringify({
            to,
            account: accountLabel(userRow, "a sua conta"),
            update_url: updateUrl,
            invoice_url: invoice.hosted_invoice_url ?? undefined,
            amount_label: moneyLabel(amountDue, invoice.currency),
            next_attempt_label: dateLabel(invoice.next_payment_attempt),
            final_attempt: !invoice.next_payment_attempt,
            dashboard_url: origin,
        }),
    });

    if (!ok) {
        console.error(`[billing-notify] payment-failed email failed (${status}):`, JSON.stringify(data));
        return { sent: false, reason: `worker_${status}`, recipients: to };
    }
    return { sent: true, recipients: to };
}
