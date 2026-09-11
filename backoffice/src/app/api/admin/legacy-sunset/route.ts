import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getDB, getStripe } from "@/lib/stripe";
import { isAdmin } from "@/lib/admin";
import { priceBook } from "@/lib/price-book";
import { LEGACY_MONTHLY_SUNSET, currentPriceCents, sunsetAt, tierOf } from "@/lib/billing-legacy";
import { callWorkerJson } from "@/lib/worker";

export const runtime = "edge";

/**
 * Tell Stripe when a legacy subscription ends, and tell the client.
 *
 * Nothing here runs on a schedule, and nothing needs to: Stripe keeps the date
 * and cancels on the day. An annual is marked `cancel_at_period_end`, so it runs
 * out the period already paid for; a monthly gets `cancel_at` on the fixed
 * cut-off. Both are idempotent — running this twice sets the same date twice.
 *
 * The client is emailed at the moment it is marked, months ahead, and again by
 * Stripe's own `invoice.upcoming` shortly before the renewal that will not
 * happen.
 */
export async function POST(req: NextRequest) {
    const { userId } = await auth();
    if (!userId || !(await isAdmin(userId))) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    const body = (await req.json().catch(() => ({}))) as {
        user_id?: string;
        connection_key?: string;
        dry_run?: boolean;
    };
    if (!body.user_id || !body.connection_key) {
        return NextResponse.json({ error: "user_id and connection_key are required" }, { status: 400 });
    }

    const db = getDB();
    const row: any = await db
        .prepare(
            `SELECT s.*, u.email AS user_email, u.name AS user_name, u.company_name, u.admin_label
               FROM subscriptions s LEFT JOIN users u ON u.id = s.user_id
              WHERE s.user_id = ? AND s.connection_key = ?`
        )
        .bind(body.user_id, body.connection_key)
        .first();

    if (!row) return NextResponse.json({ error: "subscription_not_found" }, { status: 404 });
    if (!row.stripe_subscription_id) {
        return NextResponse.json({ error: "no_stripe_subscription" }, { status: 400 });
    }

    const prices = await priceBook();
    const price = row.price_id ? prices.get(row.price_id) : null;
    const tier = tierOf(price);
    const interval = price?.recurring?.interval ?? (row.plan === "annual" ? "year" : row.plan === "monthly" ? "month" : null);
    if (tier !== "legacy") {
        return NextResponse.json({ error: "not_a_legacy_price", tier }, { status: 400 });
    }

    const endsAt = sunsetAt({ tier, interval, currentPeriodEnd: row.current_period_end });
    if (!endsAt) return NextResponse.json({ error: "no_end_date" }, { status: 400 });

    if (body.dry_run) {
        return NextResponse.json({ ok: true, dry_run: true, ends_at: endsAt, interval, unit_amount_cents: price?.unit_amount ?? null });
    }

    // An annual simply stops renewing. A monthly keeps its price until the fixed
    // date, which Stripe holds as `cancel_at` — and which leaves
    // `cancel_at_period_end` false, so both are mirrored below.
    const stripe = getStripe();
    let updated: any;
    try {
        updated = interval === "year"
            ? await stripe.subscriptions.update(row.stripe_subscription_id, { cancel_at_period_end: true })
            : await stripe.subscriptions.update(row.stripe_subscription_id, {
                cancel_at: Math.floor(Date.parse(LEGACY_MONTHLY_SUNSET) / 1000),
            });
    } catch (e: any) {
        return NextResponse.json({ error: `stripe_update_failed: ${e.message}` }, { status: 502 });
    }

    await db
        .prepare(
            `UPDATE subscriptions
                SET cancel_at_period_end = ?, cancel_at = ?, updated_at = CURRENT_TIMESTAMP
              WHERE user_id = ? AND connection_key = ?`
        )
        .bind(
            updated.cancel_at_period_end ? 1 : 0,
            updated.cancel_at ? new Date(updated.cancel_at * 1000).toISOString() : null,
            body.user_id,
            body.connection_key,
        )
        .run();

    // Best effort: the date is set whether or not the email leaves, and an email
    // that failed is better than a subscription silently ending.
    let emailed = false;
    const to = row.email || row.user_email;
    if (to) {
        const res = await callWorkerJson("/admin/legacy-price-email", {
            method: "POST",
            body: JSON.stringify({
                stage: "marked",
                to,
                name: row.name || row.company_name || row.admin_label || row.user_name || null,
                ends_at: endsAt,
                interval,
                current_amount_cents: price?.unit_amount ?? null,
                next_amount_cents: currentPriceCents(interval),
                connection_key: body.connection_key,
            }),
        }).catch(() => ({ ok: false }));
        emailed = !!(res as any).ok;
        if (emailed) {
            await db
                .prepare(
                    `UPDATE subscriptions SET legacy_notice_sent_for = ?, updated_at = CURRENT_TIMESTAMP
                      WHERE user_id = ? AND connection_key = ?`
                )
                .bind(`${endsAt}#marked`, body.user_id, body.connection_key)
                .run();
        }
    }

    return NextResponse.json({ ok: true, ends_at: endsAt, emailed, interval });
}
