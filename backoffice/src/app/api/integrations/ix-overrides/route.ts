import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, getImpersonationId } from "@/lib/admin";

export const runtime = "edge";

/**
 * Per-SKU overrides for the InvoiceXpress destination path.
 *
 * Stored in `product_overrides` (migration 0014). The worker's IxBuilder
 * consults this row when building each invoice line so the merchant can
 * fix Shopify-side mistakes without touching the integration-level config:
 *   - tax_rate         (override the Shopify-reported VAT rate)
 *   - vat_inclusion    ("inc" | "exc" — override the order-level
 *                       taxes_included flag on this SKU)
 *   - exemption_reason (M01…M99 — per-product exemption code)
 *   - name_override    (display name on the IX invoice line)
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
    source_reference: string;
    tax_rate: number | null;
    vat_inclusion: string | null;
    exemption_reason: string | null;
    name_override: string | null;
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
        `SELECT id, source_kind, source_reference, tax_rate, vat_inclusion,
                exemption_reason, name_override, source_name, created_at, updated_at
         FROM product_overrides
         WHERE user_id = ? AND source_kind = ? AND destination_kind = 'invoicexpress'
         ORDER BY updated_at DESC`,
    ).bind(authResult.targetUserId, sourceKind).all();

    return NextResponse.json({ overrides: (rows.results ?? []) as Row[] });
}

type PostBody = {
    source_kind?: "shopify" | "stripe";
    source_reference?: string;
    tax_rate?: number | string | null;
    vat_inclusion?: "inc" | "exc" | "" | null;
    exemption_reason?: string | null;
    name_override?: string | null;
    source_name?: string | null;
};

export async function POST(request: NextRequest) {
    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const body = await request.json() as PostBody;
    const sourceKind = body.source_kind === "stripe" ? "stripe" : "shopify";
    const sourceReference = (body.source_reference ?? "").trim();
    if (!sourceReference) return NextResponse.json({ error: "source_reference required" }, { status: 400 });

    // Normalize override fields. All four columns are nullable in DB —
    // empty string / null clears the override for that field.
    let taxRate: number | null = null;
    if (body.tax_rate !== undefined && body.tax_rate !== null && body.tax_rate !== "") {
        const n = Number(body.tax_rate);
        if (!Number.isFinite(n) || n < 0 || n > 100) {
            return NextResponse.json({ error: "tax_rate must be between 0 and 100" }, { status: 400 });
        }
        taxRate = n;
    }
    const vatInclusion: string | null = body.vat_inclusion === "inc" || body.vat_inclusion === "exc"
        ? body.vat_inclusion
        : null;
    const exemption = (body.exemption_reason ?? "").trim() || null;
    const nameOverride = (body.name_override ?? "").trim() || null;
    const sourceName = (body.source_name ?? "").trim() || null;

    // Refuse no-op rows so the table doesn't grow with empty overrides.
    if (taxRate === null && vatInclusion === null && !exemption && !nameOverride) {
        return NextResponse.json({ error: "At least one override field is required" }, { status: 400 });
    }

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.prepare(
        `INSERT INTO product_overrides
          (id, user_id, source_kind, destination_kind, source_reference,
           tax_rate, vat_inclusion, exemption_reason, name_override, source_name,
           created_at, updated_at)
         VALUES (?, ?, ?, 'invoicexpress', ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, source_kind, destination_kind, source_reference) DO UPDATE SET
           tax_rate = excluded.tax_rate,
           vat_inclusion = excluded.vat_inclusion,
           exemption_reason = excluded.exemption_reason,
           name_override = excluded.name_override,
           source_name = excluded.source_name,
           updated_at = excluded.updated_at`,
    ).bind(
        id, authResult.targetUserId, sourceKind, sourceReference,
        taxRate, vatInclusion, exemption, nameOverride, sourceName,
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
            `DELETE FROM product_overrides WHERE id = ? AND user_id = ?`,
        ).bind(id, authResult.targetUserId).run();
    } else if (sourceReference) {
        await db.prepare(
            `DELETE FROM product_overrides WHERE user_id = ? AND source_kind = ? AND destination_kind = 'invoicexpress' AND source_reference = ?`,
        ).bind(authResult.targetUserId, sourceKind, sourceReference).run();
    } else {
        return NextResponse.json({ error: "Pass either ?id= or ?source_reference=" }, { status: 400 });
    }

    return NextResponse.json({ ok: true });
}
