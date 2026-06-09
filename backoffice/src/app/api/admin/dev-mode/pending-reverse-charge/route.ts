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
    if (!targetUserId) return NextResponse.json({ error: "Missing targetUserId" }, { status: 400 });

    const shop = await resolveShopForUser(targetUserId);
    const qs = shop
        ? `shop=${encodeURIComponent(shop)}`
        : `user_id=${encodeURIComponent(targetUserId)}`;
    const { ok, status, data } = await callWorkerJson(`/admin/pending-reverse-charge?${qs}`);
    return NextResponse.json(data, { status: ok ? 200 : status });
}
