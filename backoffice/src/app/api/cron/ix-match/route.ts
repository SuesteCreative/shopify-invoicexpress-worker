import { NextRequest, NextResponse } from "next/server";
import { getDB } from "@/lib/stripe";
import { matchStripeChargeToIX } from "@/lib/invoicexpress-kapta";

export const runtime = "edge";

/**
 * Retry IX matching for pending billing_events (ix_invoice_id IS NULL) from last 7 days.
 * Auth: Bearer CRON_SECRET (header) or ?key= (Vercel cron).
 */
export async function GET(req: NextRequest) {
    const key = req.nextUrl.searchParams.get("key") || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    const expected = process.env.CRON_SECRET;
    if (!expected || key !== expected) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = getDB();
    const pending: any = await db.prepare(`
        SELECT e.id, e.user_id, e.payment_intent_id, e.amount_cents,
               s.nif, s.email, s.name, s.address
        FROM billing_events e
        LEFT JOIN subscriptions s ON s.user_id = e.user_id
        WHERE e.ix_invoice_id IS NULL
          AND e.type = 'invoice.paid'
          AND e.status = 'paid'
          AND e.created_at > datetime('now', '-7 days')
        ORDER BY e.created_at DESC
        LIMIT 50
    `).all();

    const rows: any[] = pending.results || [];
    let matched = 0;
    const errors: string[] = [];

    for (const row of rows) {
        try {
            const result = await matchStripeChargeToIX({
                payment_intent_id: row.payment_intent_id,
                candidate: {
                    nif: row.nif,
                    email: row.email,
                    name: row.name,
                    address: row.address,
                    amount_cents: row.amount_cents || 0,
                    paid_at: new Date(),
                },
            });
            if (result.ix_invoice_id) {
                await db.prepare(`
                    UPDATE billing_events
                    SET ix_invoice_id = ?, ix_invoice_permalink = ?, ix_match_method = ?, ix_match_score = ?
                    WHERE id = ?
                `).bind(result.ix_invoice_id, result.ix_invoice_permalink, result.ix_match_method, result.ix_match_score, row.id).run();
                matched++;
            }
        } catch (e: any) {
            errors.push(`${row.id}: ${e.message}`);
        }
    }

    return NextResponse.json({ checked: rows.length, matched, errors });
}
