import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getStripe, getStripeEnv, getDB } from "@/lib/stripe";
import { resolveAccountUser } from "@/lib/account";
import { stripePageLocale } from "@/lib/stripe-locale";
import { asLang } from "@/lib/user-language";

export const runtime = "edge";

/**
 * Opens the Stripe Customer Portal for the logged-in user's subscription —
 * self-service update of payment method, billing details, plan and cancellation,
 * plus invoice history. Requires the Customer Portal to be enabled/configured in
 * the Stripe dashboard (Settings → Billing → Customer portal).
 */
export async function POST(req: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        // Admins acting on an impersonated account open that user's portal.
        let targetUserId = await resolveAccountUser(req, userId);

        const db = getDB();
        const sub: any = await db.prepare(
            "SELECT stripe_customer_id FROM subscriptions WHERE user_id = ? AND stripe_customer_id IS NOT NULL ORDER BY created_at ASC LIMIT 1"
        ).bind(targetUserId).first();

        const customerId = sub?.stripe_customer_id;
        if (!customerId) {
            return NextResponse.json({ error: "No Stripe customer on file — subscribe first." }, { status: 400 });
        }

        const stripe = getStripe();
        const appOrigin = new URL(getStripeEnv("SUCCESS_REDIRECT_URL")).origin;

        // Stripe renders the portal itself, so the language has to travel with
        // the session — the client's own, not the browser's guess.
        const langRow: any = await db.prepare("SELECT language FROM users WHERE id = ?")
            .bind(targetUserId).first().catch(() => null);

        const portal = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: `${appOrigin}/faturacao`,
            locale: stripePageLocale(asLang(langRow?.language)),
        });

        return NextResponse.json({ url: portal.url });
    } catch (e: any) {
        console.error("[billing/portal] error", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
