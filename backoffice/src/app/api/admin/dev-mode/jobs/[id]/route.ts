import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";
import { callWorkerJson, resolveShopForUser } from "@/lib/worker";

export const runtime = "edge";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { userId } = await auth();
    if (!userId || !(await isAdmin(userId))) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const url = new URL(request.url);
    const targetUserId = url.searchParams.get("targetUserId");
    if (!targetUserId) return NextResponse.json({ error: "Missing targetUserId" }, { status: 400 });

    // See the logs route: fall back to user scoping for merchants with no shop.
    const shop = await resolveShopForUser(targetUserId);
    const qs = shop
        ? `shop=${encodeURIComponent(shop)}`
        : `user_id=${encodeURIComponent(targetUserId)}`;

    const { ok, status, data } = await callWorkerJson(`/admin/jobs/${id}?${qs}`);
    return NextResponse.json(data, { status: ok ? 200 : status });
}
