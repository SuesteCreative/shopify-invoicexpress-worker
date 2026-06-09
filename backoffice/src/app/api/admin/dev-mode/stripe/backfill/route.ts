import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";
import { callWorkerJson } from "@/lib/worker";

export const runtime = "edge";

export async function POST(request: NextRequest) {
    const { userId } = await auth();
    if (!userId || !(await isAdmin(userId))) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json() as {
        targetUserId: string;
        from?: string;
        to?: string;
        dry_run?: boolean;
        since_last_processed?: boolean;
        notify_emails?: string[];
        reason?: string;
    };

    if (!body.targetUserId) return NextResponse.json({ error: "Missing targetUserId" }, { status: 400 });

    const me = await currentUser();
    const triggered_by = me?.emailAddresses?.[0]?.emailAddress ?? userId;

    const { ok, status, data } = await callWorkerJson("/admin/stripe/backfill", {
        method: "POST",
        body: JSON.stringify({
            user_id: body.targetUserId,
            from: body.from,
            to: body.to,
            dry_run: body.dry_run,
            since_last_processed: body.since_last_processed,
            notify_emails: body.notify_emails,
            triggered_by,
            reason: body.reason,
        }),
    });
    return NextResponse.json(data, { status: ok ? 200 : status });
}
