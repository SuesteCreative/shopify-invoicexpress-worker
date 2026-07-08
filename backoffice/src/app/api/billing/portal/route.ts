import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getStripe, getStripeEnv, getDB } from "@/lib/stripe";

export const runtime = "edge";

/**
 * Opens the Stripe Customer Portal for the logged-in user's subscription —
 * self-service update of payment method, billing details, plan and cancellation,
 * plus invoice history. Requires the Customer Portal to be enabled/configured in
 * the Stripe dashboard (Settings → Billing → Customer portal).
 */
export async function POST(_req: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const db = getDB();
        const sub: any = await db.prepare(
            "SELECT stripe_customer_id FROM subscriptions WHERE user_id = ?"
        ).bind(userId).first();

        const customerId = sub?.stripe_customer_id;
        if (!customerId) {
            return NextResponse.json({ error: "No Stripe customer on file — subscribe first." }, { status: 400 });
        }

        const stripe = getStripe();
        const appOrigin = new URL(getStripeEnv("SUCCESS_REDIRECT_URL")).origin;

        const portal = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: `${appOrigin}/faturacao`,
        });

        return NextResponse.json({ url: portal.url });
    } catch (e: any) {
        console.error("[billing/portal] error", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
