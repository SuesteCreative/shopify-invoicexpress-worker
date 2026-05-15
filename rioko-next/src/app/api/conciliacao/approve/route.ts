import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { callWorkerJson, resolveShopForCurrentUser } from "@/lib/worker";

export async function POST(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const shop = await resolveShopForCurrentUser(userId);
    if (!shop) return NextResponse.json({ error: "No connected shopify_domain" }, { status: 404 });

    const body = await request.json() as { order_id: string; invoice_id: string };
    const me = await currentUser();
    const approvedBy = me?.emailAddresses?.[0]?.emailAddress ?? userId;

    const { ok, status, data } = await callWorkerJson("/admin/reconciliation/approve", {
        method: "POST",
        body: JSON.stringify({ shop, order_id: body.order_id, invoice_id: body.invoice_id, approved_by: approvedBy }),
    });
    return NextResponse.json(data, { status: ok ? 200 : status });
}

export async function DELETE(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const shop = await resolveShopForCurrentUser(userId);
    if (!shop) return NextResponse.json({ error: "No connected shopify_domain" }, { status: 404 });

    const url = new URL(request.url);
    const orderId = url.searchParams.get("order_id");
    if (!orderId) return NextResponse.json({ error: "Missing order_id" }, { status: 400 });

    const qs = new URLSearchParams({ shop, order_id: orderId });
    const { ok, status, data } = await callWorkerJson(`/admin/reconciliation/approve?${qs.toString()}`, { method: "DELETE" });
    return NextResponse.json(data, { status: ok ? 200 : status });
}
