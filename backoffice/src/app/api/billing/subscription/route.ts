import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getDB, isSubscriptionBlocked, subscriptionUIState, SubscriptionRow } from "@/lib/stripe";
import { isAdmin, getImpersonationId } from "@/lib/admin";

export const runtime = "edge";

export async function GET(req: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        let targetUserId = userId;
        if (await isAdmin(userId)) {
            const imp = await getImpersonationId(req);
            if (imp) targetUserId = imp;
        }

        const db = getDB();
        const sub: SubscriptionRow | null = await db.prepare(
            "SELECT * FROM subscriptions WHERE user_id = ?"
        ).bind(targetUserId).first();

        return NextResponse.json({
            subscription: sub,
            ui_state: subscriptionUIState(sub),
            blocked: isSubscriptionBlocked(sub),
        });
    } catch (e: any) {
        console.error("[billing/subscription] error", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
