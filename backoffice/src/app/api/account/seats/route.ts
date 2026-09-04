import { NextRequest, NextResponse } from "next/server";
import { getAccountContext, getAccountDB, getSeatPool } from "@/lib/account";
import { chargeSeat, resolveSeatPrice } from "@/lib/seats";

export const runtime = "edge";

/**
 * Unlock one seat: the payment step, on its own.
 *
 * The Users page shows a locked slot with the price on it; this is the button
 * behind it. It charges the card already on file (no checkout redirect) and
 * records the seat. Inviting someone is then free and only fills a seat the
 * account owns — see /api/account/members.
 */
export async function POST(req: NextRequest) {
    try {
        const ctx = await getAccountContext(req);
        if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        if (ctx.access === "viewer") return NextResponse.json({ error: "read_only" }, { status: 403 });

        const db = getAccountDB();
        if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

        const user: any = await db.prepare("SELECT role FROM users WHERE id = ?").bind(ctx.accountId).first();
        const exempt = user?.role === "superadmin" || user?.role === "hiperadmin";

        const sub: any = await db
            .prepare("SELECT status, stripe_customer_id, stripe_subscription_id FROM subscriptions WHERE user_id = ?")
            .bind(ctx.accountId)
            .first();
        const live = !!sub?.stripe_subscription_id && ["active", "trialing"].includes(String(sub?.status));
        if (!exempt && (!live || !sub?.stripe_customer_id)) {
            return NextResponse.json({ error: "subscription_required" }, { status: 402 });
        }

        const seatId = crypto.randomUUID();
        let invoiceId: string | null = null;
        let amountCents: number | null = null;

        if (!exempt) {
            try {
                const charged = await chargeSeat({
                    customerId: String(sub.stripe_customer_id),
                    accountId: ctx.accountId,
                    memberEmail: "",
                    memberRowId: seatId,
                });
                invoiceId = charged.invoice_id;
                amountCents = charged.amount_cents;
            } catch (e: any) {
                return NextResponse.json({ error: "payment_failed", detail: e?.message ?? String(e) }, { status: 402 });
            }
        } else {
            try {
                amountCents = (await resolveSeatPrice()).unit_amount;
            } catch { /* price is only a label here */ }
        }

        await db
            .prepare(`INSERT INTO account_seats (id, account_id, stripe_invoice_id, amount_cents, purchased_by)
                      VALUES (?, ?, ?, ?, ?)`)
            .bind(seatId, ctx.accountId, invoiceId, exempt ? 0 : amountCents, ctx.authUserId)
            .run();

        return NextResponse.json({
            ok: true,
            seat: { id: seatId, invoice_id: invoiceId, amount_cents: exempt ? 0 : amountCents },
            seats: await getSeatPool(ctx.accountId),
        });
    } catch (e: any) {
        console.error("[account/seats] POST", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
