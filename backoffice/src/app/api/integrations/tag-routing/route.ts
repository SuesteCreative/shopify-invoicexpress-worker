import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, getImpersonationId } from "@/lib/admin";

export const runtime = "edge";

/**
 * Tag-based invoice routing rules for InvoiceXpress.
 *
 * Stored in `tag_routing_rules` (migration 0017). When the source payload
 * contains a matching tag (Shopify order tag or Stripe metadata key:value),
 * the worker overrides ix_document_type and ix_sequence_name for that document.
 */

async function resolveTargetUser(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return { error: "Unauthorized", status: 401 as const };

    let targetUserId = userId;
    if (await isAdmin(userId)) {
        const impersonationId = await getImpersonationId(request);
        if (impersonationId) targetUserId = impersonationId;
    }
    return { userId, targetUserId };
}

type Row = {
    id: string;
    source_kind: string;
    destination_kind: string;
    tag_name: string;
    document_type: string | null;
    series_name: string | null;
    created_at: string;
    updated_at: string;
};

export async function GET(request: NextRequest) {
    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const url = new URL(request.url);
    const sourceKind = url.searchParams.get("source_kind") ?? "shopify";
    const destinationKind = url.searchParams.get("destination_kind") ?? "invoicexpress";

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    const rows = await db.prepare(
        `SELECT id, source_kind, destination_kind, tag_name, document_type, series_name, created_at, updated_at
         FROM tag_routing_rules
         WHERE user_id = ? AND source_kind = ? AND destination_kind = ?
         ORDER BY created_at ASC`,
    ).bind(authResult.targetUserId, sourceKind, destinationKind).all();

    return NextResponse.json({ rules: (rows.results ?? []) as Row[] });
}

type PostBody = {
    source_kind?: string;
    destination_kind?: string;
    tag_name?: string;
    document_type?: string | null;
    series_name?: string | null;
};

export async function POST(request: NextRequest) {
    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const body = await request.json() as PostBody;
    const sourceKind = (body.source_kind ?? "shopify").trim();
    const destinationKind = (body.destination_kind ?? "invoicexpress").trim();
    const tagName = (body.tag_name ?? "").trim();

    if (!tagName) return NextResponse.json({ error: "tag_name required" }, { status: 400 });

    const validDocTypes = ["invoice", "invoice_receipt", "invoice_draft", "invoice_receipt_draft"];
    const documentType = body.document_type && validDocTypes.includes(body.document_type)
        ? body.document_type
        : null;
    const seriesName = (body.series_name ?? "").trim() || null;

    if (!documentType && !seriesName) {
        return NextResponse.json({ error: "At least document_type or series_name must be set" }, { status: 400 });
    }

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.prepare(
        `INSERT INTO tag_routing_rules
          (id, user_id, source_kind, destination_kind, tag_name, document_type, series_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, source_kind, destination_kind, tag_name) DO UPDATE SET
           document_type = excluded.document_type,
           series_name = excluded.series_name,
           updated_at = excluded.updated_at`,
    ).bind(
        id, authResult.targetUserId, sourceKind, destinationKind,
        tagName, documentType, seriesName, now, now,
    ).run();

    return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const url = new URL(request.url);
    const id = url.searchParams.get("id");

    if (!id) return NextResponse.json({ error: "Pass ?id=" }, { status: 400 });

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    await db.prepare(
        `DELETE FROM tag_routing_rules WHERE id = ? AND user_id = ?`,
    ).bind(id, authResult.targetUserId).run();

    return NextResponse.json({ ok: true });
}
