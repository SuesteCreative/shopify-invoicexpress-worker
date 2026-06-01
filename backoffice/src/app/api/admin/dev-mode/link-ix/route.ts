import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";
import { getDB } from "@/lib/stripe";

export const runtime = "edge";

// List a user's billing events that have no IX document linked yet.
export async function GET(req: NextRequest) {
    const { userId } = await auth();
    if (!userId || !(await isAdmin(userId))) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const targetUserId = req.nextUrl.searchParams.get("targetUserId");
    if (!targetUserId) return NextResponse.json({ error: "targetUserId required" }, { status: 400 });

    const db = getDB();
    const rows: any = await db.prepare(`
        SELECT id, type, stripe_object_id, payment_intent_id, amount_cents, currency,
               status, ix_invoice_id, ix_invoice_permalink, ix_match_method, created_at
        FROM billing_events
        WHERE user_id = ? AND ix_invoice_id IS NULL
          AND type IN ('invoice.paid','invoice.payment_failed','charge.refunded')
        ORDER BY created_at DESC
        LIMIT 100
    `).bind(targetUserId).all();

    return NextResponse.json({ events: rows.results || [] });
}

// Manually attach an InvoiceXpress document to a billing event.
export async function POST(req: NextRequest) {
    const { userId } = await auth();
    if (!userId || !(await isAdmin(userId))) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json() as {
        targetUserId: string;
        billing_event_id: string;
        ix_permalink: string;
        ix_invoice_id?: string;
    };

    if (!body.targetUserId || !body.billing_event_id || !body.ix_permalink) {
        return NextResponse.json({ error: "targetUserId, billing_event_id and ix_permalink are required" }, { status: 400 });
    }

    const permalink = body.ix_permalink.trim();
    if (!/^https?:\/\//i.test(permalink)) {
        return NextResponse.json({ error: "ix_permalink must be a full URL (https://…)" }, { status: 400 });
    }

    const db = getDB();
    // Derive an IX doc id from the permalink tail if the admin didn't pass one explicitly.
    const ixId = (body.ix_invoice_id?.trim()) || permalink.replace(/\/+$/, "").split("/").pop() || "manual";

    const res: any = await db.prepare(`
        UPDATE billing_events
        SET ix_invoice_id = ?, ix_invoice_permalink = ?, ix_match_method = 'manual', ix_match_score = 100
        WHERE id = ? AND user_id = ?
    `).bind(ixId, permalink, body.billing_event_id, body.targetUserId).run();

    const changes = res?.meta?.changes ?? res?.changes ?? 0;
    if (!changes) {
        return NextResponse.json({ error: "No matching billing event for that id / user" }, { status: 404 });
    }

    return NextResponse.json({ success: true, ix_invoice_id: ixId, ix_invoice_permalink: permalink });
}
