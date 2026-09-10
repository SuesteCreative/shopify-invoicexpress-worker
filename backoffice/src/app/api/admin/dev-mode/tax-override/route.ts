import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";
import { callWorkerJson, resolveShopForUser } from "@/lib/worker";

export const runtime = "edge";

export async function GET(request: NextRequest) {
    const { userId } = await auth();
    if (!userId || !(await isAdmin(userId))) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const url = new URL(request.url);
    const targetUserId = url.searchParams.get("targetUserId");
    if (!targetUserId) return NextResponse.json({ error: "Missing targetUserId" }, { status: 400 });

    // A connection carries its own overrides; only the legacy Shopify integration
    // reads them off the account row. Without this a merchant running a shop and a
    // Stripe connection had ONE set of rates between them, and the dev-mode card
    // silently wrote whichever integration happened to own the `integrations` row.
    const sourceKind = url.searchParams.get("source_kind");
    const destinationKind = url.searchParams.get("destination_kind");
    if (sourceKind && destinationKind && sourceKind !== "shopify") {
        const qs = new URLSearchParams({ user_id: targetUserId, source_kind: sourceKind, destination_kind: destinationKind });
        const r = await callWorkerJson(`/admin/tax-override?${qs}`);
        return NextResponse.json(r.data, { status: r.ok ? 200 : r.status });
    }

    const shop = await resolveShopForUser(targetUserId);
    if (!shop) return NextResponse.json({ error: "Target user has no shopify_domain" }, { status: 404 });

    const { ok, status, data } = await callWorkerJson(`/admin/tax-override?shop=${encodeURIComponent(shop)}`);
    return NextResponse.json(data, { status: ok ? 200 : status });
}

export async function PUT(request: NextRequest) {
    const { userId } = await auth();
    if (!userId || !(await isAdmin(userId))) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const body = await request.json() as {
        targetUserId: string;
        source_kind?: string;
        destination_kind?: string;
        force_tax_rate: number | null;
        force_shipping_tax_rate: number | null;
        oss_enabled: boolean;
        b2b_reverse_charge?: boolean;
        ix_b2b_exemption_reason?: string;
    };
    const isConnection = !!body.source_kind && !!body.destination_kind && body.source_kind !== "shopify";
    const shop = isConnection ? null : await resolveShopForUser(body.targetUserId);
    if (!isConnection && !shop) return NextResponse.json({ error: "Target user has no shopify_domain" }, { status: 404 });

    const { ok, status, data } = await callWorkerJson("/admin/tax-override", {
        method: "PUT",
        body: JSON.stringify({
            ...(isConnection
                ? { user_id: body.targetUserId, source_kind: body.source_kind, destination_kind: body.destination_kind }
                : { shop }),
            force_tax_rate: body.force_tax_rate,
            force_shipping_tax_rate: body.force_shipping_tax_rate,
            oss_enabled: body.oss_enabled,
            b2b_reverse_charge: !!body.b2b_reverse_charge,
            ix_b2b_exemption_reason: body.ix_b2b_exemption_reason,
        }),
    });
    return NextResponse.json(data, { status: ok ? 200 : status });
}
