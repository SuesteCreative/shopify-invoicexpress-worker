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

    const shop = await resolveShopForUser(targetUserId);
    if (!shop) return NextResponse.json({ error: "Target user has no shopify_domain" }, { status: 404 });

    const { ok, status, data } = await callWorkerJson(`/admin/jobs/${id}?shop=${encodeURIComponent(shop)}`);
    return NextResponse.json(data, { status: ok ? 200 : status });
}
