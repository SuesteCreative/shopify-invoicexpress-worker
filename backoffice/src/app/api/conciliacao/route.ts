import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { callWorkerJson, resolveViewerId } from "@/lib/worker";

export const runtime = "edge";

export async function GET(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const viewerId = resolveViewerId(request, userId);

    const url = new URL(request.url);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (!from || !to) return NextResponse.json({ error: "Missing from/to" }, { status: 400 });

    // Worker resolves the user's active connection (Shopify→IX, Lodgify→Moloni…).
    const qs = new URLSearchParams({ user_id: viewerId, from, to });
    const { ok, status, data } = await callWorkerJson(`/admin/reconciliation?${qs.toString()}`);
    return NextResponse.json(data, { status: ok ? 200 : status });
}
