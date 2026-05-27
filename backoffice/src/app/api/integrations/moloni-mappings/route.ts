import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, getImpersonationId } from "@/lib/admin";

export const runtime = "edge";

/**
 * Explicit Stripe/Shopify → Moloni product mappings.
 *
 * Stored in `product_mappings` (migration 0013). The worker's Moloni adapter
 * looks up by (user_id, source_kind, source_reference); when a row exists it
 * uses the mapped `destination_product_id` instead of falling back to the
 * auto-create RIOKO-VARIANT-<id> pattern.
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

type MappingRow = {
    id: string;
    source_kind: string;
    destination_kind: string;
    source_reference: string;
    destination_product_id: number;
    destination_reference: string | null;
    destination_name: string | null;
    source_name: string | null;
    created_at: string;
    updated_at: string;
};

export async function GET(request: NextRequest) {
    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const url = new URL(request.url);
    const sourceKind = url.searchParams.get("source_kind") ?? "shopify";

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    const rows = await db.prepare(
        `SELECT id, source_kind, destination_kind, source_reference, destination_product_id,
                destination_reference, destination_name, source_name, created_at, updated_at
         FROM product_mappings
         WHERE user_id = ? AND source_kind = ? AND destination_kind = 'moloni'
         ORDER BY updated_at DESC`,
    ).bind(authResult.targetUserId, sourceKind).all();

    return NextResponse.json({ mappings: (rows.results ?? []) as MappingRow[] });
}

type PostBody = {
    source_kind?: "shopify" | "stripe";
    source_reference?: string;
    destination_product_id?: number | string;
    destination_reference?: string;
    destination_name?: string;
    source_name?: string;
};

export async function POST(request: NextRequest) {
    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const body = await request.json() as PostBody;
    const sourceKind = body.source_kind === "stripe" ? "stripe" : "shopify";
    const sourceReference = (body.source_reference ?? "").trim();
    const destProductId = Number(body.destination_product_id);

    if (!sourceReference) return NextResponse.json({ error: "source_reference required" }, { status: 400 });
    if (!Number.isFinite(destProductId) || destProductId <= 0) {
        return NextResponse.json({ error: "destination_product_id required (positive integer)" }, { status: 400 });
    }

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.prepare(
        `INSERT INTO product_mappings
          (id, user_id, source_kind, destination_kind, source_reference,
           destination_product_id, destination_reference, destination_name,
           source_name, created_at, updated_at)
         VALUES (?, ?, ?, 'moloni', ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, source_kind, destination_kind, source_reference) DO UPDATE SET
           destination_product_id = excluded.destination_product_id,
           destination_reference = excluded.destination_reference,
           destination_name = excluded.destination_name,
           source_name = excluded.source_name,
           updated_at = excluded.updated_at`,
    ).bind(
        id, authResult.targetUserId, sourceKind, sourceReference,
        destProductId,
        body.destination_reference ?? null,
        body.destination_name ?? null,
        body.source_name ?? null,
        now, now,
    ).run();

    return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    const sourceReference = url.searchParams.get("source_reference");
    const sourceKind = url.searchParams.get("source_kind") ?? "shopify";

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    if (id) {
        await db.prepare(
            `DELETE FROM product_mappings WHERE id = ? AND user_id = ?`,
        ).bind(id, authResult.targetUserId).run();
    } else if (sourceReference) {
        await db.prepare(
            `DELETE FROM product_mappings WHERE user_id = ? AND source_kind = ? AND destination_kind = 'moloni' AND source_reference = ?`,
        ).bind(authResult.targetUserId, sourceKind, sourceReference).run();
    } else {
        return NextResponse.json({ error: "Pass either ?id= or ?source_reference=" }, { status: 400 });
    }

    return NextResponse.json({ ok: true });
}
