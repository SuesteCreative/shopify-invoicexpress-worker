import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";
import { callWorkerJson, resolveShopForUser } from "@/lib/worker";

export const runtime = "edge";

async function workerScope(targetUserId: string): Promise<string> {
    // Prefer ?shop= for Shopify users (worker still supports it) and fall back
    // to ?user_id= for Stripe-only users.
    const shop = await resolveShopForUser(targetUserId);
    return shop
        ? `shop=${encodeURIComponent(shop)}`
        : `user_id=${encodeURIComponent(targetUserId)}`;
}

export async function GET(request: NextRequest) {
    const { userId } = await auth();
    if (!userId || !(await isAdmin(userId))) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(request.url);
    const targetUserId = url.searchParams.get("targetUserId");
    if (!targetUserId) return NextResponse.json({ error: "Missing targetUserId" }, { status: 400 });

    const qs = await workerScope(targetUserId);
    const { ok, status, data } = await callWorkerJson(`/admin/notify-emails?${qs}`);
    return NextResponse.json(data, { status: ok ? 200 : status });
}

export async function PUT(request: NextRequest) {
    const { userId } = await auth();
    if (!userId || !(await isAdmin(userId))) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json() as { targetUserId: string; emails: string[] };
    const shop = await resolveShopForUser(body.targetUserId);
    const { ok, status, data } = await callWorkerJson("/admin/notify-emails", {
        method: "PUT",
        body: JSON.stringify({
            shop: shop ?? undefined,
            user_id: shop ? undefined : body.targetUserId,
            emails: body.emails,
        }),
    });
    return NextResponse.json(data, { status: ok ? 200 : status });
}
