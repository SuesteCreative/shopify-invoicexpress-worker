import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getDB } from "@/lib/stripe";
import { isAdmin, getImpersonationId } from "@/lib/admin";

export const runtime = "edge";

export async function GET(req: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        let targetUserId = userId;
        if (await isAdmin(userId)) {
            const imp = await getImpersonationId(req);
            if (imp) targetUserId = imp;
        }

        const db = getDB();
        const rows: any = await db.prepare(`
            SELECT id, type, stripe_object_id, payment_intent_id, amount_cents, currency,
                   status, ix_invoice_id, ix_invoice_permalink, ix_match_method, ix_match_score,
                   created_at
            FROM billing_events
            WHERE user_id = ? AND type IN ('invoice.paid','invoice.payment_failed')
            ORDER BY created_at DESC
            LIMIT 100
        `).bind(targetUserId).all();

        return NextResponse.json({ events: rows.results || [] });
    } catch (e: any) {
        console.error("[billing/invoices] error", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
