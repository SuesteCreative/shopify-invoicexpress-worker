import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { callWorkerJson, resolveShopForCurrentUser } from "@/lib/worker";

export async function POST(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const shop = await resolveShopForCurrentUser(userId);
    if (!shop) return NextResponse.json({ error: "No connected shopify_domain" }, { status: 404 });

    const body = await request.json() as { order_number: number; reason?: string };
    const me = await currentUser();
    const triggered_by = me?.emailAddresses?.[0]?.emailAddress ?? userId;

    const { ok, status, data } = await callWorkerJson("/admin/reemit-order", {
        method: "POST",
        body: JSON.stringify({ shop, order_number: body.order_number, reason: body.reason ?? "Emitida via Conciliação", triggered_by }),
    });
    return NextResponse.json(data, { status: ok ? 200 : status });
}
