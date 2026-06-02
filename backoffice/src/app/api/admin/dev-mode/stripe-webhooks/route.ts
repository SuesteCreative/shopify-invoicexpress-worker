import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";
import { callWorkerJson } from "@/lib/worker";

export const runtime = "edge";

// List the Stripe webhook endpoints for a user's connection (status enabled/disabled).
export async function GET(req: NextRequest) {
    const { userId } = await auth();
    if (!userId || !(await isAdmin(userId))) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const targetUserId = req.nextUrl.searchParams.get("targetUserId");
    if (!targetUserId) return NextResponse.json({ error: "targetUserId required" }, { status: 400 });

    const { ok, status, data } = await callWorkerJson(`/admin/stripe/webhooks?userId=${encodeURIComponent(targetUserId)}`);
    return NextResponse.json(data, { status: ok ? 200 : status });
}

// Re-enable or delete a webhook endpoint.
export async function POST(req: NextRequest) {
    const { userId } = await auth();
    if (!userId || !(await isAdmin(userId))) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const body = await req.json() as { targetUserId: string; action: "reenable" | "delete"; endpoint_id: string };
    if (!body.targetUserId || !body.endpoint_id || !["reenable", "delete"].includes(body.action)) {
        return NextResponse.json({ error: "targetUserId, endpoint_id and action (reenable|delete) required" }, { status: 400 });
    }

    const path = body.action === "reenable" ? "/admin/stripe/webhooks/reenable" : "/admin/stripe/webhooks/delete";
    const { ok, status, data } = await callWorkerJson(path, {
        method: "POST",
        body: JSON.stringify({ userId: body.targetUserId, endpoint_id: body.endpoint_id }),
    });
    return NextResponse.json(data, { status: ok ? 200 : status });
}
