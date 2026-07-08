import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getStripe, getStripeEnv, getDB } from "@/lib/stripe";
import { isAdmin, getImpersonationId } from "@/lib/admin";

export const runtime = "edge";

export async function POST(req: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        // Admins acting on an impersonated account update that user's card.
        let targetUserId = userId;
        if (await isAdmin(userId)) {
            const imp = await getImpersonationId(req);
            if (imp) targetUserId = imp;
        }

        const db = getDB();
        const sub: any = await db.prepare(
            "SELECT stripe_customer_id FROM subscriptions WHERE user_id = ?"
        ).bind(targetUserId).first();

        let customerId = sub?.stripe_customer_id;
        if (!customerId) {
            // Email for a new customer: the impersonated user's own (from the DB),
            // falling back to the logged-in user's when acting on self.
            let email: string | null = null;
            if (targetUserId !== userId) {
                const u: any = await db.prepare("SELECT email FROM users WHERE id = ?").bind(targetUserId).first();
                email = u?.email || null;
            } else {
                const user = await currentUser();
                email = user?.emailAddresses?.[0]?.emailAddress || null;
            }
            if (!email) return NextResponse.json({ error: "No email" }, { status: 400 });
            const stripe = getStripe();
            const created = await stripe.customers.create({
                email,
                metadata: { user_id: targetUserId },
            });
            customerId = created.id;
            await db.prepare(`
                INSERT INTO subscriptions (user_id, stripe_customer_id, status, updated_at)
                VALUES (?, ?, 'incomplete', CURRENT_TIMESTAMP)
                ON CONFLICT(user_id) DO UPDATE SET
                    stripe_customer_id = excluded.stripe_customer_id,
                    updated_at = CURRENT_TIMESTAMP
            `).bind(targetUserId, customerId).run();
        }

        const stripe = getStripe();
        const successUrl = getStripeEnv("SUCCESS_REDIRECT_URL").replace("integrations/shopify-ix", "faturacao");
        const cancelUrl = getStripeEnv("CANCEL_REDIRECT_URL").replace("integrations/shopify-ix", "faturacao");

        const session = await stripe.checkout.sessions.create({
            mode: "setup",
            customer: customerId,
            success_url: successUrl,
            cancel_url: cancelUrl,
            payment_method_types: ["card"],
        });

        return NextResponse.json({ url: session.url });
    } catch (e: any) {
        console.error("[billing/update-card] error", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
