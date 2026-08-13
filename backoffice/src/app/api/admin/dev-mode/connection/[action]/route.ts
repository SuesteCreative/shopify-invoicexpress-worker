import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";
import { callWorkerJson } from "@/lib/worker";

export const runtime = "edge";

/**
 * The five recovery operations, for any connection.
 *
 * One dynamic route rather than five near-identical files: the previous
 * per-source fan-out (dev-mode/stripe/*) was five copies of Clerk auth and a
 * passthrough, and all five ended up with no caller at all. The action is
 * whitelisted, so this forwards only to routes that exist.
 */
const ACTIONS = new Set([
    "backfill", "reemit", "delete-draft", "issue-credit-note", "finalize-drafts",
]);

/** Operations that write a fiscal document, or destroy one, need a reason. */
const REASON_REQUIRED = new Set(["delete-draft", "issue-credit-note"]);

interface Body {
    targetUserId?: string;
    source?: string;
    destination?: string;
    external_id?: string;
    from?: string;
    to?: string;
    dry_run?: boolean;
    limit?: number;
    force?: boolean;
    reason?: string;
    notify_emails?: string[];
    date_strategy?: string;
    from_date?: string;
    to_date?: string;
    from_order_number?: number;
    to_order_number?: number;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ action: string }> }) {
    const { userId } = await auth();
    if (!userId || !(await isAdmin(userId))) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { action } = await params;
    if (!ACTIONS.has(action)) {
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 404 });
    }

    const body = await request.json() as Body;
    if (!body.targetUserId) return NextResponse.json({ error: "Missing targetUserId" }, { status: 400 });
    if (REASON_REQUIRED.has(action) && !body.reason?.trim()) {
        return NextResponse.json({ error: "Missing reason" }, { status: 400 });
    }

    const me = await currentUser();
    const triggered_by = me?.emailAddresses?.[0]?.emailAddress ?? userId;

    // `targetUserId` is the backoffice's name for it; the worker keys on user_id.
    const { targetUserId, ...rest } = body;
    const { ok, status, data } = await callWorkerJson(`/admin/connection/${action}`, {
        method: "POST",
        body: JSON.stringify({ ...rest, user_id: targetUserId, triggered_by }),
    });
    return NextResponse.json(data, { status: ok ? 200 : status });
}
