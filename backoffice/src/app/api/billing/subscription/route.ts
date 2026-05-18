import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getDB, isSubscriptionBlocked, subscriptionUIState, SubscriptionRow } from "@/lib/stripe";
import { isAdmin, getImpersonationId, getRole } from "@/lib/admin";

export const runtime = "edge";

export async function GET(req: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        let targetUserId = userId;
        const viewerIsAdmin = await isAdmin(userId);
        if (viewerIsAdmin) {
            const imp = await getImpersonationId(req);
            if (imp) targetUserId = imp;
        }

        const targetRole = await getRole(targetUserId);
        const targetIsAdmin = targetRole === "superadmin" || targetRole === "hiperadmin";

        // Admins/superadmins: exempt from subscription
        if (targetIsAdmin) {
            return NextResponse.json({
                subscription: null,
                ui_state: "exempt",
                blocked: false,
                role: targetRole,
            });
        }

        const db = getDB();
        const sub: SubscriptionRow | null = await db.prepare(
            "SELECT * FROM subscriptions WHERE user_id = ?"
        ).bind(targetUserId).first();

        return NextResponse.json({
            subscription: sub,
            ui_state: subscriptionUIState(sub),
            blocked: isSubscriptionBlocked(sub),
            role: targetRole,
        });
    } catch (e: any) {
        console.error("[billing/subscription] error", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
