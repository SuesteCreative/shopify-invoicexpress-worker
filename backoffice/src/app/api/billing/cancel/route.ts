import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getStripe, getDB } from "@/lib/stripe";
import { isAdmin, getImpersonationId } from "@/lib/admin";

export const runtime = "edge";

export async function POST(req: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        // Admins acting on an impersonated account manage that user's billing.
        let targetUserId = userId;
        if (await isAdmin(userId)) {
            const imp = await getImpersonationId(req);
            if (imp) targetUserId = imp;
        }

        const db = getDB();
        const sub: any = await db.prepare(
            "SELECT stripe_subscription_id FROM subscriptions WHERE user_id = ?"
        ).bind(targetUserId).first();

        if (!sub?.stripe_subscription_id) {
            return NextResponse.json({ error: "No active subscription" }, { status: 400 });
        }

        const stripe = getStripe();
        const updated = await stripe.subscriptions.update(sub.stripe_subscription_id, {
            cancel_at_period_end: true,
        });

        await db.prepare(
            "UPDATE subscriptions SET cancel_at_period_end = 1, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?"
        ).bind(targetUserId).run();

        return NextResponse.json({ success: true, cancel_at: updated.cancel_at });
    } catch (e: any) {
        console.error("[billing/cancel] error", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
