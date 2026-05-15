import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { callWorkerJson, resolveSelfShop } from "@/lib/worker";

export const runtime = "edge";

export async function POST(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const shop = await resolveSelfShop(request, userId);
    if (!shop) return NextResponse.json({ error: "No connected shopify_domain" }, { status: 404 });

    const body = await request.json() as { order_id: string; decision: string | null; reason?: string };
    const me = await currentUser();
    const decidedBy = me?.emailAddresses?.[0]?.emailAddress ?? userId;

    const { ok, status, data } = await callWorkerJson("/admin/reconciliation/decision", {
        method: "POST",
        body: JSON.stringify({ shop, order_id: body.order_id, decision: body.decision, reason: body.reason, decided_by: decidedBy }),
    });
    return NextResponse.json(data, { status: ok ? 200 : status });
}
