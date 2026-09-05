import { NextRequest, NextResponse } from "next/server";
import { getAccountContext, getAccountDB, getSeatPool } from "@/lib/account";
import { createSeatCheckout, grantSeatFromSession } from "@/lib/seats";
import { getStripe } from "@/lib/stripe";

export const runtime = "edge";

/**
 * Unlock one seat — the payment step, on its own.
 *
 * Returns a Stripe Checkout URL rather than charging the card on file: the
 * merchant sees the price, the VAT and the card before paying, and gets a
 * receipt. The seat itself is granted when the payment lands (webhook, or the
 * confirm call below when the browser returns).
 */
export async function POST(req: NextRequest) {
    try {
        const ctx = await getAccountContext(req);
        if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        if (ctx.access === "viewer") return NextResponse.json({ error: "read_only" }, { status: 403 });

        const db = getAccountDB();
        if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

        const account: any = await db
            .prepare(`SELECT u.email AS email, s.stripe_customer_id AS customer_id
                      FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id
                      WHERE u.id = ?`)
            .bind(ctx.accountId)
            .first();

        const origin = new URL(req.url).origin;
        const locale = /\/(pt|en)(\/|$)/.exec(req.headers.get("referer") ?? "")?.[1] ?? "pt";

        const checkout = await createSeatCheckout({
            accountId: ctx.accountId,
            customerId: account?.customer_id ?? null,
            email: account?.email ?? null,
            origin,
            locale,
        });

        return NextResponse.json({ ok: true, url: checkout.url, session_id: checkout.session_id });
    } catch (e: any) {
        console.error("[account/seats] POST", e);
        return NextResponse.json({ error: "checkout_failed", detail: e?.message ?? String(e) }, { status: 500 });
    }
}

/**
 * The browser coming back from Checkout: confirm the session was paid and grant
 * the seat. Idempotent with the webhook — both key the seat on the session id,
 * so whichever arrives first wins and the second is a no-op.
 */
export async function PUT(req: NextRequest) {
    try {
        const ctx = await getAccountContext(req);
        if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        if (ctx.access === "viewer") return NextResponse.json({ error: "read_only" }, { status: 403 });

        const db = getAccountDB();
        if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

        const body = (await req.json().catch(() => ({}))) as { session_id?: string };
        const sessionId = (body.session_id ?? "").trim();
        if (!sessionId.startsWith("cs_")) return NextResponse.json({ error: "invalid_session" }, { status: 400 });

        const session = await getStripe().checkout.sessions.retrieve(sessionId);

        // The session must belong to THIS account: a session id is guessable
        // enough that it must never grant a seat somewhere else.
        const owner = (session.metadata?.user_id as string) || session.client_reference_id;
        if (owner !== ctx.accountId) return NextResponse.json({ error: "not_your_session" }, { status: 403 });
        if (session.metadata?.kind !== "extra_user_seat") return NextResponse.json({ error: "not_a_seat" }, { status: 400 });
        if (session.payment_status !== "paid") return NextResponse.json({ error: "not_paid", status: session.payment_status }, { status: 402 });

        const { granted } = await grantSeatFromSession(db, session as any);
        return NextResponse.json({ ok: true, granted, seats: await getSeatPool(ctx.accountId) });
    } catch (e: any) {
        console.error("[account/seats] PUT", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
