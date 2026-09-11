import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";
import { accountLabel } from "@/lib/labels";
import { getStripe, subscriptionUIState } from "@/lib/stripe";
import { REVENUE_BY_MONTH } from "@/lib/admin-stats-sql";
import {
    PAYMENTS_BY_ACCOUNT, REFUNDS_BY_ACCOUNT, SUBSCRIPTION_LINES,
    TRIALS_ENDING, OUTSTANDING_PAYMENTS, SETTLED_AFTER_FAILURE,
    SEATS_BY_ACCOUNT, monthlyCents,
} from "@/lib/admin-finance-sql";

export const runtime = "edge";

/**
 * The money, per account and in aggregate.
 *
 * Two sources, and the split is not arbitrary. What was actually paid comes out
 * of D1, where `billing_events` keeps the payment ledger for ever on purpose.
 * What is *contracted* — MRR, ARR — cannot: `subscriptions` stores a `price_id`
 * and never an amount, and three different price points are in circulation, so
 * a hardcoded table here would be wrong for at least one of them from the day
 * it was written. One `prices.list` answers for all of them.
 *
 * The distinction is worth keeping in mind when reading the page: revenue is
 * history and MRR is a forecast, and the reason they disagree is usually that a
 * backfilled payment was booked on the day somebody linked it rather than the
 * day it was made.
 */

const rows = (r: any): any[] => (r?.results ?? []) as any[];
const num = (v: unknown) => Number(v ?? 0);

const soft = <T,>(p: Promise<T>, fallback: T, label: string): Promise<T> =>
    p.catch((e) => {
        console.error(`[admin/finance] ${label} failed:`, e?.message ?? e);
        return fallback;
    });

/**
 * Everything Stripe knows about what things cost, in one request.
 *
 * Indexed by BOTH the price id and its lookup key, because `subscriptions.
 * price_id` holds either. Checkout resolves a lookup key like
 * `shopify-ix-monthly` into a real price and, depending on the path it took,
 * stores one or the other — so nine of the fleet's live subscriptions carry a
 * lookup key in a column named for an id. Keying on `p.id` alone silently
 * priced all of them at zero.
 *
 * Archived prices are included deliberately: a client stays on the plan they
 * signed up to long after it stops being sold, and leaving those out would
 * understate MRR by exactly the legacy accounts that have paid longest.
 */
async function priceBook(): Promise<Map<string, any>> {
    const book = new Map<string, any>();
    const add = (p: any) => {
        book.set(p.id, p);
        if (p.lookup_key) book.set(p.lookup_key, p);
    };

    try {
        const stripe = getStripe();
        // The whole catalogue is a couple of dozen prices and changes almost
        // never, so a page or two is the whole answer. Asking per subscription
        // would be one round trip per client on a page that lists all of them.
        let page = await stripe.prices.list({ limit: 100 });
        page.data.forEach(add);
        let guard = 0;
        while (page.has_more && guard++ < 5) {
            page = await stripe.prices.list({ limit: 100, starting_after: page.data.at(-1)?.id });
            page.data.forEach(add);
        }
    } catch (e: any) {
        // A missing key or a Stripe outage costs the forecast, not the page.
        console.error("[admin/finance] price book failed:", e?.message ?? e);
    }
    return book;
}

export async function GET() {
    try {
        const { userId } = await auth();
        if (!userId || !(await isAdmin(userId))) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { env } = getRequestContext();
        const db = (env as any).DB;
        if (!db) return NextResponse.json({ error: "No database binding" }, { status: 500 });

        const EMPTY = { results: [] as any[] };

        const [monthRows, payRows, refundRows, subRows, trialRows, failRows, settledRow, seatRows, prices] =
            await Promise.all([
                soft(db.prepare(REVENUE_BY_MONTH).all(), EMPTY, "by_month"),
                soft(db.prepare(PAYMENTS_BY_ACCOUNT).all(), EMPTY, "payments"),
                soft(db.prepare(REFUNDS_BY_ACCOUNT).all(), EMPTY, "refunds"),
                soft(db.prepare(SUBSCRIPTION_LINES).all(), EMPTY, "subscriptions"),
                soft(db.prepare(TRIALS_ENDING).all(), EMPTY, "trials"),
                soft(db.prepare(OUTSTANDING_PAYMENTS).all(), EMPTY, "outstanding"),
                soft(db.prepare(SETTLED_AFTER_FAILURE).first(), null, "settled"),
                soft(db.prepare(SEATS_BY_ACCOUNT).all(), EMPTY, "seats"),
                priceBook(),
            ]);

        const paid = new Map<string, any>();
        for (const r of rows(payRows)) paid.set(r.user_id, r);
        const refunded = new Map<string, number>();
        for (const r of rows(refundRows)) refunded.set(r.user_id, num(r.refunded_cents));
        const seats = new Map<string, any>();
        for (const r of rows(seatRows)) seats.set(r.user_id, r);

        /** One row per account, assembled from its subscription lines. */
        const byAccount = new Map<string, any>();
        let mrrCents = 0;
        /** price_id → how many billing subscriptions carry it unresolved. Named,
         *  because "4 subscriptions have a price we could not read" is a fact an
         *  operator then has to come and ask about. */
        const unresolved = new Map<string, number>();

        for (const s of rows(subRows)) {
            const entry = byAccount.get(s.user_id) ?? {
                user_id: s.user_id,
                account: accountLabel(s, s.email),
                email: s.email ?? null,
                role: s.role,
                is_inactive: Number(s.is_inactive) === 1,
                lines: [] as any[],
                mrr_cents: 0,
            };

            const state = s.role === "superadmin" || s.role === "hiperadmin"
                ? "exempt"
                : subscriptionUIState(s as any);

            // Only a subscription Stripe is actually billing contributes to MRR.
            // A trial with no Stripe subscription behind it is free access, not
            // revenue, however alive it looks in the table.
            const price = s.price_id ? prices.get(s.price_id) : null;
            const billing = state === "active" || (state === "trialing" && !!s.stripe_subscription_id);
            const monthly = billing ? Math.round(monthlyCents(price)) : 0;
            if (billing && s.price_id && !price) {
                unresolved.set(s.price_id, (unresolved.get(s.price_id) ?? 0) + 1);
            }

            entry.lines.push({
                connection_key: s.connection_key,
                status: s.status,
                state,
                plan: s.plan ?? null,
                price_id: s.price_id ?? null,
                monthly_cents: monthly,
                /** Stripe archives a price when it stops being sold, but a client
                 *  stays on the one they signed up to. That is what "legacy"
                 *  means here, and it is the only reliable signal for it. */
                price_legacy: !!price && price.active === false,
                price_amount_cents: price?.unit_amount ?? null,
                price_interval: price?.recurring?.interval ?? null,
                current_period_end: s.current_period_end ?? null,
                trial_end: s.trial_end ?? null,
                early_bird: Number(s.early_bird ?? 0) === 1,
                cancel_at_period_end: Number(s.cancel_at_period_end ?? 0) === 1,
                has_stripe_sub: !!s.stripe_subscription_id,
            });
            entry.mrr_cents += monthly;
            mrrCents += monthly;
            byAccount.set(s.user_id, entry);
        }

        const accounts = [...byAccount.values()].map((a) => {
            const p = paid.get(a.user_id);
            const gross = num(p?.gross_cents);
            const back = refunded.get(a.user_id) ?? 0;
            const seat = seats.get(a.user_id);
            return {
                ...a,
                gross_cents: gross,
                refunded_cents: back,
                seat_cents: num(seat?.cents),
                seats: num(seat?.n),
                // What this client is worth in total: subscriptions net of
                // refunds, plus seats, which never pass through the ledger.
                net_cents: gross - back + num(seat?.cents),
                payments: num(p?.payments),
                last_payment_at: p?.last_payment_at ?? null,
            };
        }).sort((a, b) => b.net_cents - a.net_cents);

        const revenue = rows(monthRows).map((r) => ({
            ym: r.ym as string,
            gross_cents: num(r.gross_cents),
            refunded_cents: num(r.refunded_cents),
            net_cents: num(r.gross_cents) - num(r.refunded_cents),
        }));

        const seatTotal = [...seats.values()].reduce((acc, s) => acc + num(s.cents), 0);
        const subscriptionNet = revenue.reduce((acc, r) => acc + r.net_cents, 0);

        return NextResponse.json({
            revenue,
            subscription_net_cents: subscriptionNet,
            seat_cents: seatTotal,
            lifetime_net_cents: subscriptionNet + seatTotal,
            mrr_cents: mrrCents,
            arr_cents: mrrCents * 12,
            /** Subscriptions Stripe is billing whose price we could not read —
             *  MRR is short by whatever they are worth, and saying so is the
             *  difference between a forecast and a guess. */
            prices_missing: [...unresolved.values()].reduce((a, b) => a + b, 0),
            unresolved_prices: [...unresolved.entries()]
                .map(([price_id, n]) => ({ price_id, n }))
                .sort((a, b) => b.n - a.n),
            price_book_size: prices.size,
            accounts,
            trials_ending: rows(trialRows).map((t) => ({
                user_id: t.user_id,
                account: accountLabel(t, t.email),
                connection_key: t.connection_key,
                trial_end: t.trial_end,
            })),
            outstanding_payments: rows(failRows).map((f) => ({
                id: f.id,
                invoice_id: f.invoice_id,
                user_id: f.user_id,
                account: accountLabel(f, f.email),
                amount_cents: num(f.amount_cents),
                currency: f.currency ?? "eur",
                created_at: f.created_at,
                attempts: num(f.attempts),
                reason: f.reason ?? null,
                description: f.description ?? null,
            })),
            /** Failures that the retry collected. Shown as context so the list
             *  above reads as the exception it is. */
            settled_after_failure: num((settledRow as any)?.n),
        });
    } catch (error: any) {
        console.error("[admin/finance] failed:", error?.message ?? error);
        return NextResponse.json({ error: "finance_failed" }, { status: 500 });
    }
}
