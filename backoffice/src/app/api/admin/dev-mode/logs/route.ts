import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";
import { callWorkerJson, resolveShopForUser } from "@/lib/worker";

export const runtime = "edge";

export async function GET(request: NextRequest) {
    const { userId } = await auth();
    if (!userId || !(await isAdmin(userId))) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(request.url);
    const targetUserId = url.searchParams.get("targetUserId");
    const type = url.searchParams.get("type") ?? "jobs";
    const limit = url.searchParams.get("limit") ?? "100";
    if (!targetUserId) return NextResponse.json({ error: "Missing targetUserId" }, { status: 400 });

    const shop = await resolveShopForUser(targetUserId);
    const qs = new URLSearchParams({ type, limit });
    if (shop) qs.set("shop", shop);
    else qs.set("user_id", targetUserId);
    const { ok, status, data } = await callWorkerJson(`/admin/logs?${qs.toString()}`);
    return NextResponse.json(data, { status: ok ? 200 : status });
}
