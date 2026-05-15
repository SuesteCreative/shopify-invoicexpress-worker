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

    const body = await request.json() as {
        targetUserId: string;
        type: "create_orders" | "finalize_orders";
        from?: string;
        to?: string;
        order_ids?: number[];
        dry_run?: boolean;
        since_last_processed?: boolean;
        notify_emails?: string[];
        reason?: string;
    };

    const shop = await resolveShopForUser(body.targetUserId);
    if (!shop) return NextResponse.json({ error: "Target user has no shopify_domain" }, { status: 404 });

    const me = await currentUser();
    const triggered_by = me?.emailAddresses?.[0]?.emailAddress ?? userId;

    const { ok, status, data } = await callWorkerJson("/admin/process-orders", {
        method: "POST",
        body: JSON.stringify({
            shop,
            type: body.type,
            from: body.from,
            to: body.to,
            order_ids: body.order_ids,
            dry_run: body.dry_run,
            since_last_processed: body.since_last_processed,
            notify_emails: body.notify_emails,
            triggered_by,
            reason: body.reason,
        }),
    });
    return NextResponse.json(data, { status: ok ? 200 : status });
}
