import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getDB } from "@/lib/stripe";
import { isAdmin } from "@/lib/admin";
import { primaryConnectionKey, listSubscriptions, getStripe, earlyBirdState } from "@/lib/stripe";
import { resolveTier } from "@/lib/billing-legacy";
import { keyFromRequest } from "@/lib/subscription-key";

export const runtime = "edge";

/**
 * Admin endpoint: set early_bird + trial_end for a specific user.
 * If no subscription row exists, creates one with status='trialing'.
 * If user already paid (stripe_subscription_id present), does NOT touch Stripe side
 * — only updates local early_bird/trial_end metadata.
 */
export async function POST(req: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId || !(await isAdmin(userId))) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = (await req.json()) as {
            user_id?: string;
            early_bird?: boolean;
            trial_end?: string | null;
            connection_key?: string;
            /** true/false is a deliberate answer from an operator; null clears
             *  it and lets the price decide again (migration 0054). */
            legacy_price?: boolean | null;
        };
        const targetUserId = body.user_id;
        if (!targetUserId) return NextResponse.json({ error: "user_id required" }, { status: 400 });

        // Validate trial_end if provided — must be a valid ISO date string in the future (or null)
        let trialEndIso: string | null = body.trial_end || null;
        if (trialEndIso) {
            const d = new Date(trialEndIso);
            if (isNaN(d.getTime())) return NextResponse.json({ error: "Invalid trial_end format" }, { status: 400 });
            trialEndIso = d.toISOString();
        }
        // If marking early_bird=true, require a trial_end (otherwise user gets free service forever).
        if (body.early_bird && !trialEndIso) {
            return NextResponse.json({ error: "trial_end required when early_bird=true" }, { status: 400 });
        }
        // ...and require it to be in the future, which this endpoint claimed to
        // check and did not. A date already past grants nothing: the gate reads
        // it as expired, the merchant is refused, and superadmin shows "No sub"
        // for an account somebody just deliberately gave free access to.
        // Measured on Vandersol (09/09/2026): 16/08 stored where 16/09 was meant,
        // because the form offered a date from a campaign that had ended.
        if (body.early_bird && trialEndIso && new Date(trialEndIso).getTime() <= Date.now()) {
            return NextResponse.json(
                { error: `trial_end ${trialEndIso.slice(0, 10)} is in the past — an early bird that has already expired grants no access` },
                { status: 400 },
            );
        }

        // Absent means "leave it alone", not "clear it" — hence the COALESCE on
        // the update below. This endpoint is also how trial dates are saved, and
        // a form that does not carry the toggle must not silently reset it.
        //
        // NULL in the column means nobody has answered and the price decides;
        // 0 and 1 are an operator's answer and win. See lib/billing-legacy.
        const legacyPrice = body.legacy_price === true ? 1
            : body.legacy_price === false ? 0
            : null;

        const db = getDB();

        // Which connection the grant is for (0044). Unnamed, it lands on the
        // account's oldest — the one an existing subscription already pays for.
        const connectionKey = body.connection_key
            ? keyFromRequest(body.connection_key, null)
            : await primaryConnectionKey(db, targetUserId);

        const existing: any = await db.prepare(
            "SELECT user_id, status, stripe_subscription_id FROM subscriptions WHERE user_id = ? AND connection_key = ?"
        ).bind(targetUserId, connectionKey).first();

        // `admin_override_at` marks these dates as deliberately set, so the
        // integrations save, the Stripe webhook and link-subscription stop
        // overwriting them (migration 0028).
        if (existing) {
            await db.prepare(`
                UPDATE subscriptions
                SET early_bird = ?, trial_end = ?, legacy_price = COALESCE(?, legacy_price),
                    admin_override_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                WHERE user_id = ? AND connection_key = ?
            `).bind(
                body.early_bird ? 1 : 0,
                trialEndIso,
                legacyPrice,
                targetUserId,
                connectionKey,
            ).run();
        } else {
            await db.prepare(`
                INSERT INTO subscriptions (user_id, connection_key, status, trial_end, early_bird, legacy_price, admin_override_at, created_at, updated_at)
                VALUES (?, ?, 'trialing', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `).bind(
                targetUserId,
                connectionKey,
                trialEndIso,
                body.early_bird ? 1 : 0,
                legacyPrice,
            ).run();
        }

        const updated: any = await db.prepare(
            "SELECT user_id, connection_key, status, trial_end, early_bird, legacy_price, stripe_subscription_id, admin_override_at FROM subscriptions WHERE user_id = ? AND connection_key = ?"
        ).bind(targetUserId, connectionKey).first();

        return NextResponse.json({ success: true, subscription: updated });
    } catch (e: any) {
        console.error("[admin/subscription] error", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

/**
 * Which plan this account is on, from whichever source can answer.
 *
 * The Stripe price is asked for only when the column has not been set by hand,
 * because a deliberate answer beats it anyway and this runs on a page an
 * operator opens per client.
 */
async function resolveLegacyForUser(db: D1Database, userId: string, sub: any) {
    const override = sub?.legacy_price ?? null;
    if (override === 1 || override === 0) return resolveTier({ override });

    let price: any = null;
    if (sub?.price_id) {
        try {
            price = await getStripe().prices.retrieve(sub.price_id);
        } catch {
            // Stripe unreachable, or a lookup key stored where an id belongs —
            // both land on the paid-amount fallback below.
        }
    }

    // Gross, and the most recent one: a plan change shows up here first.
    const paid: any = await db.prepare(
        `SELECT amount_cents FROM billing_events
          WHERE user_id = ? AND type = 'invoice.paid' AND amount_cents > 0
          ORDER BY created_at DESC LIMIT 1`
    ).bind(userId).first().catch(() => null);

    return resolveTier({ override, price, paidGrossCents: paid?.amount_cents ?? null });
}

export async function GET(req: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId || !(await isAdmin(userId))) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const targetUserId = req.nextUrl.searchParams.get("user_id");
        if (!targetUserId) return NextResponse.json({ error: "user_id required" }, { status: 400 });

        const db = getDB();
        // Every row on the account, so the console can show a connection that
        // nothing pays for — which is the state this whole change makes visible.
        const subs = await listSubscriptions(db, targetUserId);

        return NextResponse.json({
            subscription: subs[0] ?? null,
            subscriptions: subs,
            // The resolved answer, not just the raw column: the toggle shows
            // what the fleet currently believes, and `source` is what stops a
            // derivation being read as somebody's decision.
            legacy: await resolveLegacyForUser(db, targetUserId, subs[0] ?? null),
            // What the early-bird flag means on this row. It records that the
            // deal was granted and is never turned off, so it survives both the
            // window closing and the client converting — the console has to say
            // which of those it is looking at.
            early_bird_state: earlyBirdState(subs[0] ?? null),
        });
    } catch (e: any) {
        console.error("[admin/subscription GET] error", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
