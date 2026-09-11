import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { isAdmin } from "@/lib/admin";
import {
    CUSTOMERS, CUSTOMERS_LEGACY,
    SIGNUPS_BY_MONTH, FUNNEL, REVENUE_BY_MONTH, OTHER_CURRENCIES,
    SUBSCRIPTIONS_BY_STATE, DOCUMENTS_BY_MONTH, CHANNELS,
    ATTRIBUTION_COVERAGE, SEAT_REVENUE,
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

export async function GET() {
    try {
        const { userId } = await auth();
        if (!userId || !(await isAdmin(userId))) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { env } = getRequestContext();
        const db = (env as any).DB;
        if (!db) return NextResponse.json({ error: "No database binding" }, { status: 500 });

        // account_members arrived in migration 0039. Probe once here rather than
        // giving all five customer-scoped queries a fallback of their own.
        const customers: string = await db
            .prepare(`SELECT COUNT(*) AS n FROM (${CUSTOMERS})`)
            .first()
            .then(() => CUSTOMERS)
            .catch(() => CUSTOMERS_LEGACY);

        const [
            signupRows, funnelRow, revenueRows, otherCurrencyRows,
            subRows, docRows, channelRows, attributionRow, seatRow,
        ] = await Promise.all([
            db.prepare(SIGNUPS_BY_MONTH(customers)).all(),
            db.prepare(FUNNEL(customers)).first(),
            db.prepare(REVENUE_BY_MONTH).all(),
            db.prepare(OTHER_CURRENCIES).all(),
            db.prepare(SUBSCRIPTIONS_BY_STATE).all(),
            db.prepare(DOCUMENTS_BY_MONTH).all(),
            db.prepare(CHANNELS(customers)).all(),
            db.prepare(ATTRIBUTION_COVERAGE(customers)).first(),
            // account_seats arrived in 0040, and an unapplied migration must not
            // take the whole page down with it.
            db.prepare(SEAT_REVENUE).first().catch(() => ({ n: 0, cents: 0 })),
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
            lifetime_net_cents: revenue.reduce((a, r) => a + r.net_cents, 0),
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
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
