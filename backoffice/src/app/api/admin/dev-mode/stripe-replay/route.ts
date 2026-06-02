import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";
import { callWorkerJson } from "@/lib/worker";

export const runtime = "edge";

// Replay missed Stripe event(s) into the processing queue.
//   { targetUserId, event_id }                  → replay one event
//   { targetUserId, type?, from?, to?, limit? }  → backfill a window (unix seconds)
export async function POST(req: NextRequest) {
    const { userId } = await auth();
    if (!userId || !(await isAdmin(userId))) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const body = await req.json() as {
        targetUserId: string;
        event_id?: string;
        type?: string;
        from?: number;
        to?: number;
        limit?: number;
    };
    if (!body.targetUserId) return NextResponse.json({ error: "targetUserId required" }, { status: 400 });
    if (!body.event_id && !body.from && !body.to) {
        return NextResponse.json({ error: "Provide event_id, or a from/to window" }, { status: 400 });
    }

    const { ok, status, data } = await callWorkerJson("/admin/stripe/replay", {
        method: "POST",
        body: JSON.stringify({
            userId: body.targetUserId,
            event_id: body.event_id,
            type: body.type,
            from: body.from,
            to: body.to,
            limit: body.limit,
        }),
    });
    return NextResponse.json(data, { status: ok ? 200 : status });
}
