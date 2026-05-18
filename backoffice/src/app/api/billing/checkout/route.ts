import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getStripe, getStripeEnv, getStripeEnvOptional, getDB } from "@/lib/stripe";
import { isAdmin, getImpersonationId } from "@/lib/admin";

export const runtime = "edge";

export async function POST(req: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        // If admin is impersonating, checkout creates subscription FOR the impersonated user
        let targetUserId = userId;
        let targetEmail: string | null = null;
        if (await isAdmin(userId)) {
            const imp = await getImpersonationId(req);
            if (imp) {
                targetUserId = imp;
                const db0 = getDB();
                const u: any = await db0.prepare("SELECT email FROM users WHERE id = ?").bind(imp).first();
                targetEmail = u?.email || null;
            }
        }

        if (!targetEmail) {
            const user = await currentUser();
            targetEmail = user?.emailAddresses?.[0]?.emailAddress || null;
        }
        if (!targetEmail) return NextResponse.json({ error: "No email for target user" }, { status: 400 });
        const email = targetEmail;

        const body = (await req.json().catch(() => ({}))) as { plan?: "monthly" | "annual" };
        const plan = body.plan === "annual" ? "annual" : "monthly";

        const stripe = getStripe();
        const lookupOrId = plan === "annual"
            ? getStripeEnv("STRIPE_PRICE_YEARLY_LOOKUP")
            : getStripeEnv("STRIPE_PRICE_MONTHLY_LOOKUP");

        // Accept any of: real price ID (price_xxx), custom ID, or lookup_key.
        // Try retrieve first (works for any valid Stripe ID), then fall back to lookup_keys.
        let priceId: string | null = null;
        try {
            const p = await stripe.prices.retrieve(lookupOrId);
            if (p?.id) priceId = p.id;
        } catch {
            // not a valid id — try lookup_keys
        }
        if (!priceId) {
            const prices = await stripe.prices.list({ lookup_keys: [lookupOrId], limit: 1 });
            priceId = prices.data[0]?.id || null;
        }
        if (!priceId) return NextResponse.json({ error: `Price not found: ${lookupOrId}` }, { status: 500 });

        const db = getDB();
        const sub: any = await db.prepare(
            "SELECT stripe_customer_id, stripe_subscription_id, status, early_bird, trial_end FROM subscriptions WHERE user_id = ?"
        ).bind(targetUserId).first();

        // Determine trial config
        const trialEndIso = getStripeEnvOptional("EARLY_BIRD_TRIAL_END") || "2026-08-01T00:00:00Z";
        const trialEndUnix = Math.floor(new Date(trialEndIso).getTime() / 1000);
        const nowUnix = Math.floor(Date.now() / 1000);

        const isEarlyBird = !!sub?.early_bird;
        const useTrial = isEarlyBird && trialEndUnix > nowUnix;

        const successUrl = getStripeEnv("SUCCESS_REDIRECT_URL");
        const cancelUrl = getStripeEnv("CANCEL_REDIRECT_URL");

        const session = await stripe.checkout.sessions.create({
            mode: "subscription",
            line_items: [{ price: priceId, quantity: 1 }],
            customer: sub?.stripe_customer_id || undefined,
            customer_email: sub?.stripe_customer_id ? undefined : email,
            client_reference_id: targetUserId,
            automatic_tax: { enabled: true },
            tax_id_collection: { enabled: true },
            billing_address_collection: "required",
            phone_number_collection: { enabled: true },
            custom_fields: [{
                key: "nif",
                label: { type: "custom", custom: "NIF (opcional)" },
                type: "text",
                optional: true,
            }],
            subscription_data: {
                metadata: {
                    user_id: targetUserId,
                    early_bird: isEarlyBird ? "1" : "0",
                    plan,
                },
                trial_end: useTrial ? trialEndUnix : undefined,
            },
            payment_method_collection: "always",
            metadata: {
                user_id: targetUserId,
                plan,
                early_bird: isEarlyBird ? "1" : "0",
            },
            success_url: successUrl,
            cancel_url: cancelUrl,
            allow_promotion_codes: true,
        });

        return NextResponse.json({ url: session.url, id: session.id });
    } catch (e: any) {
        console.error("[Stripe checkout] error", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
