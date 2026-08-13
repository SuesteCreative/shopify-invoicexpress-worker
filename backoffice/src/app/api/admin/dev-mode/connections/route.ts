import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";
import { callWorkerJson } from "@/lib/worker";

export const runtime = "edge";

/**
 * The connections a user has, and what can be done to each.
 *
 * A thin proxy on purpose: the capability matrix is built in the worker, from
 * the adapters that implement it. Deciding here which cards to show would mean
 * two places knowing which destinations can issue a credit note, and they would
 * disagree the first time one of them changed.
 */
export async function GET(request: NextRequest) {
    const { userId } = await auth();
    if (!userId || !(await isAdmin(userId))) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const targetUserId = new URL(request.url).searchParams.get("targetUserId");
    if (!targetUserId) return NextResponse.json({ error: "Missing targetUserId" }, { status: 400 });

    const { ok, status, data } = await callWorkerJson(
        `/admin/connection/capabilities?user_id=${encodeURIComponent(targetUserId)}`,
    );
    return NextResponse.json(data, { status: ok ? 200 : status });
}
