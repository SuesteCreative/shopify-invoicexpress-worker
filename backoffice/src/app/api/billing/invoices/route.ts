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
            WHERE user_id = ? AND type IN ('invoice.paid','invoice.payment_failed','charge.refunded')
            ORDER BY created_at DESC
            LIMIT 100
        `).bind(targetUserId).all();

        // Collapse invoice lifecycle rows: a single invoice can emit both an
        // open/failed event and a later paid event. Once paid, show only the
        // paid row. Refunds (charge.refunded) are distinct audit lines, kept as-is.
        const all: any[] = rows.results || [];
        const refunds = all.filter(e => e.type === "charge.refunded");
        const invoiceEvents = all.filter(e => e.type !== "charge.refunded");

        const byInvoice = new Map<string, any[]>();
        for (const e of invoiceEvents) {
            const key = e.stripe_object_id || e.id;
            const g = byInvoice.get(key);
            if (g) g.push(e); else byInvoice.set(key, [e]);
        }

        const collapsed: any[] = [];
        for (const group of byInvoice.values()) {
            // rows arrive newest-first; prefer a paid row, else keep the latest.
            const paid = group.find(e => e.status === "paid");
            collapsed.push(paid || group[0]);
        }

        const events = [...collapsed, ...refunds].sort(
            (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );

        return NextResponse.json({ events });
    } catch (e: any) {
        console.error("[billing/invoices] error", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
