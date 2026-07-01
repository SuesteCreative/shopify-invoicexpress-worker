import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { callWorkerJson, resolveViewerId } from "@/lib/worker";

export const runtime = "edge";

export async function POST(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const viewerId = resolveViewerId(request, userId);
    const body = await request.json() as { order_id: string; invoice_id: string };
    const me = await currentUser();
    const approvedBy = me?.emailAddresses?.[0]?.emailAddress ?? userId;

    const { ok, status, data } = await callWorkerJson("/admin/reconciliation/approve", {
        method: "POST",
        body: JSON.stringify({ user_id: viewerId, order_id: body.order_id, invoice_id: body.invoice_id, approved_by: approvedBy }),
    });
    return NextResponse.json(data, { status: ok ? 200 : status });
}

export async function DELETE(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const viewerId = resolveViewerId(request, userId);
    const url = new URL(request.url);
    const orderId = url.searchParams.get("order_id");
    if (!orderId) return NextResponse.json({ error: "Missing order_id" }, { status: 400 });

    const qs = new URLSearchParams({ user_id: viewerId, order_id: orderId });
    const { ok, status, data } = await callWorkerJson(`/admin/reconciliation/approve?${qs.toString()}`, { method: "DELETE" });
    return NextResponse.json(data, { status: ok ? 200 : status });
}
