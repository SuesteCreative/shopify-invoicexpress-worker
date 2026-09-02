import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { callWorkerJson, resolveViewerId } from "@/lib/worker";

export const runtime = "edge";

export async function GET(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const viewerId = await resolveViewerId(request, userId);

    const url = new URL(request.url);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (!from || !to) return NextResponse.json({ error: "Missing from/to" }, { status: 400 });

    // Worker resolves the user's active connection (Shopify→IX, Lodgify→Moloni…).
    const qs = new URLSearchParams({ user_id: viewerId, from, to });
    // `refresh` has to be forwarded explicitly — this is an allowlist, so an
    // unlisted parameter is silently dropped and the button would do nothing.
    // It skips the cached reference lookups (never the worker's own budget or
    // concurrency caps), which is how a stale "sem fatura" is re-checked without
    // waiting out the cache.
    if (url.searchParams.get("refresh") === "1") qs.set("refresh", "1");
    const { ok, status, data } = await callWorkerJson(`/admin/reconciliation?${qs.toString()}`);
    return NextResponse.json(data, { status: ok ? 200 : status });
}
