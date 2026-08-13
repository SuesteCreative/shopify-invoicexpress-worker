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

    // Shop-keyed when the merchant has one, so Shopify behaviour is unchanged;
    // user-keyed otherwise. A Stripe- or Lodgify-only merchant has no
    // shopify_domain, and this used to 404 rather than show their logs at all.
    const shop = await resolveShopForUser(targetUserId);
    const qs = new URLSearchParams(shop ? { shop, type, limit } : { user_id: targetUserId, type, limit });
    const { ok, status, data } = await callWorkerJson(`/admin/logs?${qs.toString()}`);
    return NextResponse.json(data, { status: ok ? 200 : status });
}
