import Stripe from "stripe";
import { matchStripeChargeToIX } from "@/lib/invoicexpress-kapta";
import { loadBillingIdentity } from "@/lib/billing-identity";

/**
 * Point an existing Stripe subscription at one connection, and make the account
 * read as paying for it.
 *
 * Written for the admin route that links a subscription bought through a Payment
 * Link, and now also for an onboarding invite, which is the same operation
 * decided in advance: a client who already pays should not be shown a payment
 * form for the pair they are moving to.
 *
 * It MOVES, it does not copy. Stamping `metadata.connection_key` is what makes
 * every future renewal and cancellation file against this connection — which
 * also means the row for whatever connection the subscription paid for until now
 * stops receiving events. `retireConnectionKey` closes that row; without it the
 * row sat `active` for ever, kept its gate open after the client cancelled, and
 * left two rows claiming the same `stripe_subscription_id` — which the webhook's
 * own resolver can then follow back to the connection this link just moved away
 * from.
 */

/**
 * Close the rows this subscription used to pay for.
 *
 * Any row of the account pointing at the same Stripe subscription under a
 * different connection is now a claim on money that is being spent elsewhere.
 * The pointer is cleared as well as the status: leaving it would let the
 * webhook resolve a future renewal back onto the connection just vacated.
 */
export async function retireConnectionKey(
    db: any, userId: string, subscriptionId: string, keepKey: string,
): Promise<number> {
    const res = await db.prepare(`
        UPDATE subscriptions
           SET status = 'canceled', stripe_subscription_id = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND stripe_subscription_id = ? AND connection_key <> ?
    `).bind(userId, subscriptionId, keepKey).run();
    return Number(res?.meta?.changes ?? 0);
}

export function isoFromUnix(unix: number | null | undefined): string | null {
    if (!unix) return null;
    return new Date(unix * 1000).toISOString();
}

export interface LinkSubscriptionResult {
    ok: true;
    ix_matched: boolean;
    subscription: { id: string; status: string; plan: string; price_id: string | null; current_period_end: string | null };
}

export async function linkSubscriptionToConnection(opts: {
    db: any;
    stripe: Stripe;
    userId: string;
    sub: any;
    connectionKey: string;
}): Promise<LinkSubscriptionResult> {
    const { db, stripe, userId, sub, connectionKey } = opts;

    const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
    const item = sub.items?.data?.[0];
    const priceId = item?.price?.id || null;
    const plan = (sub.metadata?.plan as string) || (item?.price?.recurring?.interval === "year" ? "annual" : "monthly");

    // Stamp our user_id so future renewal/cancel webhooks resolve to this
    // account, and the resolved key so they file the row on the same connection
    // this link just chose.
    try {
        await stripe.subscriptions.update(sub.id, {
            metadata: { ...(sub.metadata || {}), app: "rioko", user_id: userId, connection_key: connectionKey },
        });
    } catch (e: any) {
        console.warn("[link-subscription] metadata stamp failed:", e?.message ?? e);
    }

    // Upsert the Rioko subscription row. early_bird is preserved (DB owns it).
    await db.prepare(`
        INSERT INTO subscriptions (user_id, connection_key, stripe_customer_id, stripe_subscription_id, status,
                                   plan, price_id, current_period_end, trial_end,
                                   cancel_at_period_end, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, connection_key) DO UPDATE SET
            stripe_customer_id = excluded.stripe_customer_id,
            stripe_subscription_id = excluded.stripe_subscription_id,
            status = excluded.status,
            plan = excluded.plan,
            price_id = excluded.price_id,
            current_period_end = excluded.current_period_end,
            -- A NULL Stripe trial_end (the norm for Rioko subs) must not erase
            -- an admin-set early-bird date. See migration 0028.
            trial_end = CASE WHEN subscriptions.admin_override_at IS NOT NULL AND excluded.trial_end IS NULL
                             THEN subscriptions.trial_end ELSE excluded.trial_end END,
            cancel_at_period_end = excluded.cancel_at_period_end,
            updated_at = CURRENT_TIMESTAMP
    `).bind(
        userId,
        connectionKey,
        customerId || null,
        sub.id,
        sub.status,
        plan,
        priceId,
        isoFromUnix((sub as any).current_period_end),
        isoFromUnix(sub.trial_end),
        sub.cancel_at_period_end ? 1 : 0,
    ).run();

    // The move is only half done until the row it moved FROM stops claiming it.
    try {
        const closed = await retireConnectionKey(db, userId, sub.id, connectionKey);
        if (closed) console.warn(`[link-subscription] retired ${closed} row(s) that still claimed ${sub.id}`);
    } catch (e: any) {
        console.warn("[link-subscription] retire old connection failed:", e?.message ?? e);
    }

    // The fiscal identity, from the Stripe customer.
    //
    // These columns are normally a copy of what the client typed into the
    // Checkout Session — and a client who arrives by invite never sees one, so
    // the row used to be written without a single one of them. That is not a
    // cosmetic gap: it is the identity the Kapta document is matched on, and
    // without it a payment matches on amount and date alone, which is how a
    // 50,00 EUR payment landed on another client's cancelled invoice.
    //
    // Stripe holds it because the subscription was sold through a Payment Link,
    // which collects name, email and (with tax id collection on) the NIF.
    // COALESCE throughout: a row filled by a real checkout is never overwritten
    // by a thinner Customer record.
    try {
        const customer: any = customerId
            ? await stripe.customers.retrieve(customerId, { expand: ["tax_ids"] })
            : null;
        if (customer && !customer.deleted) {
            const addr = customer.address || null;
            // Stripe stores a Portuguese VAT number as "PT123456789"; the Kapta
            // documents carry the nine digits. Anything else is not a NIF and
            // must not be offered to the matcher as if it were.
            const raw = String(customer.tax_ids?.data?.find((t: any) => t.value)?.value || "")
                .replace(/^PT/i, "").trim();
            const nif = /^\d{9}$/.test(raw) ? raw : null;
            await db.prepare(`
                UPDATE subscriptions SET
                    nif = COALESCE(NULLIF(nif, ''), ?),
                    name = COALESCE(NULLIF(name, ''), ?),
                    email = COALESCE(NULLIF(email, ''), ?),
                    phone = COALESCE(NULLIF(phone, ''), ?),
                    address = COALESCE(NULLIF(address, ''), ?),
                    city = COALESCE(NULLIF(city, ''), ?),
                    zip = COALESCE(NULLIF(zip, ''), ?),
                    country = COALESCE(NULLIF(country, ''), ?),
                    updated_at = CURRENT_TIMESTAMP
                WHERE user_id = ? AND connection_key = ?
            `).bind(
                nif, customer.name || null, customer.email || null, customer.phone || null,
                addr?.line1 || null, addr?.city || null, addr?.postal_code || null, addr?.country || null,
                userId, connectionKey,
            ).run();
        }
    } catch (e: any) {
        console.warn("[link-subscription] customer identity fill failed:", e?.message ?? e);
    }

    // Release any connection paused pending payment + stamp the invoice cutoff.
    try {
        const subStart = isoFromUnix((sub as any).start_date);
        await db.prepare(
            `UPDATE connections SET status='active', invoice_cutoff = COALESCE(invoice_cutoff, ?), updated_at=CURRENT_TIMESTAMP
             WHERE user_id = ? AND status = 'paused'`
        ).bind(subStart, userId).run();
        // Linking a subscription by hand is also the moment we learn when the
        // client actually started paying — so an already-active connection that
        // never had a cutoff gets this subscription's start instead of keeping
        // the day its row happened to be created. COALESCE keeps an admin's own
        // date; the panel can still override it afterwards.
        await db.prepare(
            `UPDATE connections SET invoice_cutoff = COALESCE(invoice_cutoff, ?), updated_at=CURRENT_TIMESTAMP
             WHERE user_id = ? AND status = 'active'`
        ).bind(subStart, userId).run();
    } catch (e: any) {
        console.warn("[link-subscription] connection activate failed:", e?.message ?? e);
    }

    // Record the latest paid invoice + match it to the Kapta IX invoice so the
    // payment and the IX invoice link show in this account's billing history.
    let ixMatched = false;
    try {
        const inv: any = sub.latest_invoice;
        const pi = inv?.payment_intent;
        const piId = typeof pi === "string" ? pi : pi?.id;
        if (inv && inv.status === "paid" && piId) {
            const subRow = await loadBillingIdentity(db, userId);
            const custEmail = typeof sub.customer === "object" ? sub.customer?.email : null;
            const custName = typeof sub.customer === "object" ? sub.customer?.name : null;

            await db.prepare(`
                INSERT OR IGNORE INTO billing_events (id, user_id, type, stripe_object_id, payment_intent_id, amount_cents, currency, status, raw_json)
                VALUES (?, ?, 'invoice.paid', ?, ?, ?, ?, 'paid', ?)
            `).bind(
                inv.id, userId, inv.id, piId, inv.amount_paid || 0, inv.currency || "eur",
                // The invoice NUMBER goes in, not just the subscription id: it is the
                // reference Kapta stamps on the document, and without it a retry of
                // this event by the nightly cron has nothing exact left to search on.
                JSON.stringify({ manual_link: true, subscription: sub.id, number: inv.number || null }),
            ).run();

            const match = await matchStripeChargeToIX({
                payment_intent_id: piId,
                invoice_number: inv.number || null,
                candidate: {
                    nif: subRow?.nif || null,
                    email: subRow?.email || custEmail || null,
                    name: subRow?.name || custName || null,
                    address: subRow?.address || null,
                    amount_cents: inv.amount_paid || 0,
                    paid_at: new Date((inv.status_transitions?.paid_at || Date.now() / 1000) * 1000),
                },
            });
            if (match.ix_invoice_id) {
                ixMatched = true;
                await db.prepare(`
                    UPDATE billing_events SET ix_invoice_id = ?, ix_invoice_permalink = ?, ix_match_method = ?, ix_match_score = ?
                    WHERE id = ?
                `).bind(match.ix_invoice_id, match.ix_invoice_permalink, match.ix_match_method, match.ix_match_score, inv.id).run();
            }
        }
    } catch (e: any) {
        console.warn("[link-subscription] billing_event / IX match failed:", e?.message ?? e);
    }

    return {
        ok: true,
        ix_matched: ixMatched,
        subscription: {
            id: sub.id,
            status: sub.status,
            plan,
            price_id: priceId,
            current_period_end: isoFromUnix((sub as any).current_period_end),
        },
    };
}
