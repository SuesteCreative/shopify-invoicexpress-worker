import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";
import { callWorkerJson, resolveShopForUser } from "@/lib/worker";

export const runtime = "edge";

export async function POST(request: NextRequest) {
    const { userId } = await auth();
    if (!userId || !(await isAdmin(userId))) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const body = await request.json() as { targetUserId: string; order_number: number; reason?: string; notify_emails?: string[] };
    const shop = await resolveShopForUser(body.targetUserId);
    if (!shop) return NextResponse.json({ error: "Target user has no shopify_domain" }, { status: 404 });

    const me = await currentUser();
    const triggered_by = me?.emailAddresses?.[0]?.emailAddress ?? userId;

    const { ok, status, data } = await callWorkerJson("/admin/delete-draft", {
        method: "POST",
        body: JSON.stringify({ shop, order_number: body.order_number, reason: body.reason, triggered_by, notify_emails: body.notify_emails }),
    });
    return NextResponse.json(data, { status: ok ? 200 : status });
}
