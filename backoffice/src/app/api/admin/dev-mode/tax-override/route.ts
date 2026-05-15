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
    if (!shop) return NextResponse.json({ error: "Target user has no shopify_domain" }, { status: 404 });

    const { ok, status, data } = await callWorkerJson(`/admin/tax-override?shop=${encodeURIComponent(shop)}`);
    return NextResponse.json(data, { status: ok ? 200 : status });
}

export async function PUT(request: NextRequest) {
    const { userId } = await auth();
    if (!userId || !(await isAdmin(userId))) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const body = await request.json() as { targetUserId: string; force_tax_rate: number | null; force_shipping_tax_rate: number | null; oss_enabled: boolean };
    const shop = await resolveShopForUser(body.targetUserId);
    if (!shop) return NextResponse.json({ error: "Target user has no shopify_domain" }, { status: 404 });

    const { ok, status, data } = await callWorkerJson("/admin/tax-override", {
        method: "PUT",
        body: JSON.stringify({ shop, force_tax_rate: body.force_tax_rate, force_shipping_tax_rate: body.force_shipping_tax_rate, oss_enabled: body.oss_enabled }),
    });
    return NextResponse.json(data, { status: ok ? 200 : status });
}
