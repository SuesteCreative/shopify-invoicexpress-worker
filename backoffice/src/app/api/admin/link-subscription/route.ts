import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getStripe, getDB } from "@/lib/stripe";
import { isAdmin } from "@/lib/admin";
import { matchStripeChargeToIX } from "@/lib/invoicexpress-kapta";

export const runtime = "edge";

function isoFromUnix(unix: number | null | undefined): string | null {
    if (!unix) return null;
    return new Date(unix * 1000).toISOString();
}

/**
 * Admin: manually associate an existing Stripe subscription (e.g. one created via
 * a Payment Link, which carries no user_id metadata) with a Rioko account. Stamps
 * metadata.user_id so future webhooks resolve, upserts the local subscription row,
 * releases any paused connection, and records the latest paid invoice + matches it
 * to the Kapta IX invoice so the payment shows in the account's billing history.
 */
export async function POST(req: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId || !(await isAdmin(userId))) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
        }

        const body = (await req.json().catch(() => ({}))) as { user_id?: string; subscription_id?: string };
        const targetUserId = body.user_id?.trim();
        const subscriptionId = body.subscription_id?.trim();
        if (!targetUserId || !subscriptionId) {
            return NextResponse.json({ error: "user_id and subscription_id are required" }, { status: 400 });
        }
        if (!subscriptionId.startsWith("sub_")) {
            return NextResponse.json({ error: "subscription_id must be a Stripe subscription id (sub_…)" }, { status: 400 });
        }

        const stripe = getStripe();
        const db = getDB();

        let sub: any;
        try {
            sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["customer", "latest_invoice.payment_intent"] });
        } catch (e: any) {
            return NextResponse.json({ error: `Stripe subscription not found: ${e.message}` }, { status: 404 });
        }

        const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
        const item = sub.items?.data?.[0];
        const priceId = item?.price?.id || null;
        const plan = (sub.metadata?.plan as string) || (item?.price?.recurring?.interval === "year" ? "annual" : "monthly");

        // Stamp our user_id so future renewal/cancel webhooks resolve to this account.
        try {
            await stripe.subscriptions.update(subscriptionId, {
                metadata: { ...(sub.metadata || {}), app: "rioko", user_id: targetUserId },
            });
        } catch (e: any) {
            console.warn("[link-subscription] metadata stamp failed:", e?.message ?? e);
        }

        // Upsert the Rioko subscription row. early_bird is preserved (DB owns it).
        await db.prepare(`
            INSERT INTO subscriptions (user_id, stripe_customer_id, stripe_subscription_id, status,
                                       plan, price_id, current_period_end, trial_end,
                                       cancel_at_period_end, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id) DO UPDATE SET
                stripe_customer_id = excluded.stripe_customer_id,
                stripe_subscription_id = excluded.stripe_subscription_id,
                status = excluded.status,
                plan = excluded.plan,
                price_id = excluded.price_id,
                current_period_end = excluded.current_period_end,
                trial_end = excluded.trial_end,
                cancel_at_period_end = excluded.cancel_at_period_end,
                updated_at = CURRENT_TIMESTAMP
        `).bind(
            targetUserId,
            customerId || null,
            sub.id,
            sub.status,
            plan,
            priceId,
            isoFromUnix((sub as any).current_period_end),
            isoFromUnix(sub.trial_end),
            sub.cancel_at_period_end ? 1 : 0,
        ).run();

        // Release any connection paused pending payment + stamp the invoice cutoff.
        try {
            await db.prepare(
                `UPDATE connections SET status='active', invoice_cutoff = COALESCE(invoice_cutoff, ?), updated_at=CURRENT_TIMESTAMP
                 WHERE user_id = ? AND status = 'paused'`
            ).bind(isoFromUnix((sub as any).start_date), targetUserId).run();
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
                const subRow: any = await db.prepare("SELECT nif, name, email, address FROM subscriptions WHERE user_id = ?").bind(targetUserId).first();
                const custEmail = typeof sub.customer === "object" ? sub.customer?.email : null;
                const custName = typeof sub.customer === "object" ? sub.customer?.name : null;

                await db.prepare(`
                    INSERT OR IGNORE INTO billing_events (id, user_id, type, stripe_object_id, payment_intent_id, amount_cents, currency, status, raw_json)
                    VALUES (?, ?, 'invoice.paid', ?, ?, ?, ?, 'paid', ?)
                `).bind(inv.id, targetUserId, inv.id, piId, inv.amount_paid || 0, inv.currency || "eur", JSON.stringify({ manual_link: true, subscription: sub.id })).run();

                const match = await matchStripeChargeToIX({
                    payment_intent_id: piId,
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

        return NextResponse.json({
            ok: true,
            ix_matched: ixMatched,
            subscription: {
                id: sub.id,
                status: sub.status,
                plan,
                price_id: priceId,
                customer: customerId,
                current_period_end: isoFromUnix((sub as any).current_period_end),
            },
        });
    } catch (e: any) {
        console.error("[link-subscription] error", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
