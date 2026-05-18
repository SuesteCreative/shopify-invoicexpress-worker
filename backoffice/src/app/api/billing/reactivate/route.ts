import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getStripe, getDB } from "@/lib/stripe";

export const runtime = "edge";

export async function POST(_req: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const db = getDB();
        const sub: any = await db.prepare(
            "SELECT stripe_subscription_id FROM subscriptions WHERE user_id = ?"
        ).bind(userId).first();

        if (!sub?.stripe_subscription_id) {
            return NextResponse.json({ error: "No subscription" }, { status: 400 });
        }

        const stripe = getStripe();
        await stripe.subscriptions.update(sub.stripe_subscription_id, {
            cancel_at_period_end: false,
        });

        await db.prepare(
            "UPDATE subscriptions SET cancel_at_period_end = 0, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?"
        ).bind(userId).run();

        return NextResponse.json({ success: true });
    } catch (e: any) {
        console.error("[billing/reactivate] error", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
