import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { isAdmin } from "@/lib/admin";
import {
    CUSTOMERS,
    SIGNUPS_BY_MONTH, FUNNEL, REVENUE_BY_MONTH, OTHER_CURRENCIES,
    SUBSCRIPTIONS_BY_STATE, DOCUMENTS_BY_MONTH, CHANNELS,
    ATTRIBUTION_COVERAGE, SEAT_REVENUE, BLOCKED_BY_GATE,
} from "@/lib/admin-stats-sql";

export const runtime = "edge";

/**
 * The numbers behind /admin's overview, all of them out of D1.
 *
 * The queries live in lib/admin-stats-sql.ts, with the reasons each one is
 * shaped the way it is, and a test that runs them against real SQLite. They are
 * separate from this file for exactly that reason: a route that imports Clerk
 * and getRequestContext cannot be loaded by a unit test, and money arithmetic
 * that nothing checks is money arithmetic that is quietly wrong.
 */

const rows = (r: any): any[] => (r?.results ?? []) as any[];
const num = (v: unknown) => Number(v ?? 0);

/**
 * Every read degrades on its own.
 *
 * Promise.all rejects on the first failure, so one query naming a column an
 * un-applied migration has not added yet would blank the entire overview —
 * funnel, revenue and all. The acquisition reads are the live risk: the acq_*
 * columns come from backoffice/migrations, a second directory applied by hand.
 * A card that says nothing is a bad card; a page that says nothing is an outage.
 */
const soft = <T,>(p: Promise<T>, fallback: T, label: string): Promise<T> =>
    p.catch((e) => {
        console.error(`[admin/stats] ${label} failed:`, e?.message ?? e);
        return fallback;
    });

export async function GET() {
    try {
        const { userId } = await auth();
        if (!userId || !(await isAdmin(userId))) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { env } = getRequestContext();
        const db = (env as any).DB;
        if (!db) return NextResponse.json({ error: "No database binding" }, { status: 500 });

        const customers = CUSTOMERS;
        const EMPTY = { results: [] as any[] };

        const [
            signupRows, funnelRow, revenueRows, otherCurrencyRows,
            subRows, docRows, channelRows, attributionRow, seatRow, blockedRow,
        ] = await Promise.all([
            soft(db.prepare(SIGNUPS_BY_MONTH(customers)).all(), EMPTY, "signups"),
            soft(db.prepare(FUNNEL(customers)).first(), null, "funnel"),
            soft(db.prepare(REVENUE_BY_MONTH).all(), EMPTY, "revenue"),
            soft(db.prepare(OTHER_CURRENCIES).all(), EMPTY, "other_currencies"),
            soft(db.prepare(SUBSCRIPTIONS_BY_STATE).all(), EMPTY, "subscriptions"),
            soft(db.prepare(DOCUMENTS_BY_MONTH).all(), EMPTY, "documents"),
            soft(db.prepare(CHANNELS(customers)).all(), EMPTY, "channels"),
            soft(db.prepare(ATTRIBUTION_COVERAGE(customers)).first(), null, "attribution"),
            soft(db.prepare(SEAT_REVENUE).first(), { n: 0, cents: 0 }, "seats"),
            soft(db.prepare(BLOCKED_BY_GATE(customers)).first(), null, "blocked"),
        ]);

        const revenue = rows(revenueRows).map((r) => ({
            ym: r.ym as string,
            gross_cents: num(r.gross_cents),
            refunded_cents: num(r.refunded_cents),
            net_cents: num(r.gross_cents) - num(r.refunded_cents),
        }));

        return NextResponse.json({
            signups: rows(signupRows).map((r) => ({ ym: r.ym, n: num(r.n) })),
            funnel: {
                accounts: num((funnelRow as any)?.accounts),
                registered: num((funnelRow as any)?.registered),
                connected: num((funnelRow as any)?.connected),
                paying: num((funnelRow as any)?.paying),
                mid_setup: num((funnelRow as any)?.mid_setup),
            },
            revenue,
            subscription_net_cents: revenue.reduce((a, r) => a + r.net_cents, 0),
            // Seats are revenue too. A KPI called "total" that leaves a revenue
            // line out is the number an operator quotes wrong to someone else.
            lifetime_net_cents:
                revenue.reduce((a, r) => a + r.net_cents, 0) + num((seatRow as any)?.cents),
            blocked: num((blockedRow as any)?.n),
            other_currencies: rows(otherCurrencyRows).map((r) => ({
                currency: r.currency, n: num(r.n), cents: num(r.cents),
            })),
            subscriptions: rows(subRows).map((r) => ({
                status: r.status, connection_key: r.connection_key, n: num(r.n),
            })),
            documents: rows(docRows).map((r) => ({ ym: r.ym, n: num(r.n) })),
            channels: rows(channelRows).map((r) => ({ source: r.source, n: num(r.n) })),
            attribution: {
                total: num((attributionRow as any)?.total),
                captured: num((attributionRow as any)?.captured),
            },
            seats: { n: num((seatRow as any)?.n), cents: num((seatRow as any)?.cents) },
        });
    } catch (error: any) {
        // The message can carry D1 table and column names. Admin-only route, but
        // there is no reason to hand the schema to a browser console.
        console.error("[admin/stats] failed:", error?.message ?? error);
        return NextResponse.json({ error: "stats_failed" }, { status: 500 });
    }
}
