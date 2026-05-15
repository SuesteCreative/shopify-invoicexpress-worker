import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { callWorkerJson, resolveShopForCurrentUser } from "@/lib/worker";

export async function GET(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const shop = await resolveShopForCurrentUser(userId);
    if (!shop) return NextResponse.json({ error: "No connected shopify_domain" }, { status: 404 });

    const url = new URL(request.url);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (!from || !to) return NextResponse.json({ error: "Missing from/to" }, { status: 400 });

    const qs = new URLSearchParams({ shop, from, to });
    const { ok, status, data } = await callWorkerJson(`/admin/reconciliation?${qs.toString()}`);
    return NextResponse.json(data, { status: ok ? 200 : status });
}
