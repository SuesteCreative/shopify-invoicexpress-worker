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
        stripe_id: string;
        force?: boolean;
        reason?: string;
        notify_emails?: string[];
    };

    if (!body.targetUserId || !body.stripe_id) {
        return NextResponse.json({ error: "Missing targetUserId or stripe_id" }, { status: 400 });
    }

    const me = await currentUser();
    const triggered_by = me?.emailAddresses?.[0]?.emailAddress ?? userId;

    const { ok, status, data } = await callWorkerJson("/admin/stripe/reemit", {
        method: "POST",
        body: JSON.stringify({
            user_id: body.targetUserId,
            stripe_id: body.stripe_id,
            force: body.force,
            reason: body.reason,
            triggered_by,
            notify_emails: body.notify_emails,
        }),
    });
    return NextResponse.json(data, { status: ok ? 200 : status });
}
