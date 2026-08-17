import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";
import { getDB } from "@/lib/stripe";

export const runtime = "edge";

/**
 * When each of a user's connections starts invoicing, and where that date came
 * from.
 *
 * Read straight from D1 rather than through the worker's capabilities endpoint
 * because the panel needs a distinction that endpoint deliberately collapses:
 * it answers with the EFFECTIVE cutoff (the column, else the row's created_at),
 * which is the right answer for "will this sale be billed" and the wrong one for
 * an editor — an admin has to see whether a date was actually stored or is just
 * the day the connection happened to be created.
 */
export async function GET(request: NextRequest) {
    const { userId } = await auth();
    if (!userId || !(await isAdmin(userId))) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const targetUserId = new URL(request.url).searchParams.get("targetUserId");
    if (!targetUserId) return NextResponse.json({ error: "Missing targetUserId" }, { status: 400 });

    const db = getDB();
    const rows = await db.prepare(
        `SELECT source_kind, destination_kind, status, invoice_cutoff, created_at
           FROM connections
          WHERE user_id = ? AND status != 'archived'
          ORDER BY updated_at DESC`
    ).bind(targetUserId).all();

    const connections = ((rows.results ?? []) as any[]).map((r) => ({
        source: String(r.source_kind),
        destination: String(r.destination_kind),
        status: String(r.status),
        // What is stored, what is used, and which of the two the UI is showing.
        invoice_cutoff: r.invoice_cutoff ?? null,
        created_at: r.created_at ?? null,
        effective: (r.invoice_cutoff ?? r.created_at) ?? null,
        source_of_date: r.invoice_cutoff ? "explicit" : "connection_created",
    }));

    return NextResponse.json({ connections });
}
