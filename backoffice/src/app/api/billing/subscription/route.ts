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
                viewer_is_admin: viewerIsAdmin,
                user_id: targetUserId,
            });
        }

        const db = getDB();
        const sub: SubscriptionRow | null = await db.prepare(
            "SELECT * FROM subscriptions WHERE user_id = ?"
        ).bind(targetUserId).first();

        // Plan pricing is per-integration (stripe-moloni is €5/€50, not the
        // default €7.50/€75). Surface the customer's integration so the billing
        // page can label the plan with the right price. Keyed on the connection,
        // since the subscription row itself carries no source.
        let plan_source: string | null = null;
        if (sub) {
            const conn: any = await db.prepare(
                "SELECT 1 FROM connections WHERE user_id = ? AND source_kind = 'stripe' AND destination_kind = 'moloni' LIMIT 1"
            ).bind(targetUserId).first();
            if (conn) plan_source = "stripe-moloni";
        }

        return NextResponse.json({
            subscription: sub,
            ui_state: subscriptionUIState(sub),
            blocked: isSubscriptionBlocked(sub),
            role: targetRole,
            plan_source,
            viewer_is_admin: viewerIsAdmin,
            user_id: targetUserId,
        });
    } catch (e: any) {
        console.error("[billing/subscription] error", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
