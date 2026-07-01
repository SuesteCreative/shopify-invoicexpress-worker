import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { callWorkerJson, resolveSelfShop } from "@/lib/worker";

export const runtime = "edge";

export async function POST(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Manual re-emit currently supports the Shopify→IX flow only (reemit by
    // order number). Non-Shopify sources issue automatically on webhook.
    const shop = await resolveSelfShop(request, userId);
    if (!shop) return NextResponse.json({ error: "Emissão manual disponível apenas para integrações Shopify." }, { status: 404 });

    const body = await request.json() as { order_number: number; reason?: string };
    const me = await currentUser();
    const triggered_by = me?.emailAddresses?.[0]?.emailAddress ?? userId;

    const { ok, status, data } = await callWorkerJson("/admin/reemit-order", {
        method: "POST",
        body: JSON.stringify({ shop, order_number: body.order_number, reason: body.reason ?? "Emitida via Conciliação", triggered_by }),
    });
    return NextResponse.json(data, { status: ok ? 200 : status });
}
