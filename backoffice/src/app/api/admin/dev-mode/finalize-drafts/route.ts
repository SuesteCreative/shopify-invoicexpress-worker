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
        dry_run?: boolean;
        limit?: number;
        reason?: string;
        notify_emails?: string[];
        date_strategy?: "today" | "closest_available";
        from_order_number?: number | null;
        to_order_number?: number | null;
        from_date?: string | null;
        to_date?: string | null;
    };

    const shop = await resolveShopForUser(body.targetUserId);
    if (!shop) return NextResponse.json({ error: "Target user has no shopify_domain" }, { status: 404 });

    const me = await currentUser();
    const triggered_by = me?.emailAddresses?.[0]?.emailAddress ?? userId;

    const { ok, status, data } = await callWorkerJson("/admin/finalize-drafts", {
        method: "POST",
        body: JSON.stringify({
            shop,
            dry_run: body.dry_run,
            limit: body.limit,
            reason: body.reason,
            triggered_by,
            notify_emails: body.notify_emails,
            date_strategy: body.date_strategy,
            from_order_number: body.from_order_number,
            to_order_number: body.to_order_number,
            from_date: body.from_date,
            to_date: body.to_date,
        }),
    });
    return NextResponse.json(data, { status: ok ? 200 : status });
}
