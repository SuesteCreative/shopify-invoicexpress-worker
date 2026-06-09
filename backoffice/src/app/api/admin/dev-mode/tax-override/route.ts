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

    const shop = await resolveShopForUser(targetUserId);
    const qs = shop
        ? `shop=${encodeURIComponent(shop)}`
        : `user_id=${encodeURIComponent(targetUserId)}`;
    const { ok, status, data } = await callWorkerJson(`/admin/tax-override?${qs}`);
    return NextResponse.json(data, { status: ok ? 200 : status });
}

export async function PUT(request: NextRequest) {
    const { userId } = await auth();
    if (!userId || !(await isAdmin(userId))) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const body = await request.json() as {
        targetUserId: string;
        force_tax_rate: number | null;
        force_shipping_tax_rate: number | null;
        oss_enabled: boolean;
        b2b_reverse_charge?: boolean;
        ix_b2b_exemption_reason?: string;
    };
    const shop = await resolveShopForUser(body.targetUserId);
    const { ok, status, data } = await callWorkerJson("/admin/tax-override", {
        method: "PUT",
        body: JSON.stringify({
            shop: shop ?? undefined,
            user_id: shop ? undefined : body.targetUserId,
            force_tax_rate: body.force_tax_rate,
            force_shipping_tax_rate: body.force_shipping_tax_rate,
            oss_enabled: body.oss_enabled,
            b2b_reverse_charge: !!body.b2b_reverse_charge,
            ix_b2b_exemption_reason: body.ix_b2b_exemption_reason,
        }),
    });
    return NextResponse.json(data, { status: ok ? 200 : status });
}
