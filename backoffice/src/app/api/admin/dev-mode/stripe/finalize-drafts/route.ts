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
        dry_run?: boolean;
        limit?: number;
        reason?: string;
        notify_emails?: string[];
        date_strategy?: "today" | "closest_available";
        from_date?: string | null;
        to_date?: string | null;
    };

    if (!body.targetUserId) return NextResponse.json({ error: "Missing targetUserId" }, { status: 400 });

    const me = await currentUser();
    const triggered_by = me?.emailAddresses?.[0]?.emailAddress ?? userId;

    const { ok, status, data } = await callWorkerJson("/admin/stripe/finalize-drafts", {
        method: "POST",
        body: JSON.stringify({
            user_id: body.targetUserId,
            dry_run: body.dry_run,
            limit: body.limit,
            reason: body.reason,
            triggered_by,
            notify_emails: body.notify_emails,
            date_strategy: body.date_strategy,
            from_date: body.from_date,
            to_date: body.to_date,
        }),
    });
    return NextResponse.json(data, { status: ok ? 200 : status });
}
