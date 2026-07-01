import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { callWorkerJson, resolveViewerId } from "@/lib/worker";

export const runtime = "edge";

export async function POST(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const viewerId = resolveViewerId(request, userId);
    const body = await request.json() as { order_id: string; decision: string | null; reason?: string };
    const me = await currentUser();
    const decidedBy = me?.emailAddresses?.[0]?.emailAddress ?? userId;

    const { ok, status, data } = await callWorkerJson("/admin/reconciliation/decision", {
        method: "POST",
        body: JSON.stringify({ user_id: viewerId, order_id: body.order_id, decision: body.decision, reason: body.reason, decided_by: decidedBy }),
    });
    return NextResponse.json(data, { status: ok ? 200 : status });
}
