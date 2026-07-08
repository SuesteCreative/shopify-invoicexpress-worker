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

        const body = (await req.json().catch(() => ({}))) as { plan?: "monthly" | "annual"; source?: string };
        const plan = body.plan === "annual" ? "annual" : "monthly";
        const source = body.source ?? "";

        const stripe = getStripe();
        const isLodgify = source.startsWith("lodgify");
        const isStripeMoloni = source === "stripe-moloni";
        // stripe-moloni has its own price points (€5/mo, €50/yr). The lookup keys
        // are stable and not secret, so they're hardcoded rather than env-gated —
        // the checkout resolves lookup keys via the prices.list fallback below.
        const lookupOrId = isStripeMoloni
            ? (plan === "annual" ? "stripe-moloni-yearly" : "stripe-moloni-monthly")
            : plan === "annual"
            ? (isLodgify ? getStripeEnv("STRIPE_PRICE_LODGIFY_YEARLY_LOOKUP") : getStripeEnv("STRIPE_PRICE_YEARLY_LOOKUP"))
            : (isLodgify ? getStripeEnv("STRIPE_PRICE_LODGIFY_MONTHLY_LOOKUP") : getStripeEnv("STRIPE_PRICE_MONTHLY_LOOKUP"));

        // Accept any of: real price ID (price_xxx), custom ID, or lookup_key.
        // Try retrieve first (works for any valid Stripe ID), then fall back to lookup_keys.
        let price: any = null;
        try {
            price = await stripe.prices.retrieve(lookupOrId);
        } catch {
            // not a valid id — try lookup_keys
        }
        if (!price) {
            const prices = await stripe.prices.list({ lookup_keys: [lookupOrId], limit: 1, active: true });
            price = prices.data[0];
        }
        if (!price) return NextResponse.json({ error: `Price not found: ${lookupOrId}` }, { status: 500 });
        if (!price.active) return NextResponse.json({ error: `Price ${price.id} is inactive` }, { status: 500 });
        if (price.currency !== "eur") return NextResponse.json({ error: `Price ${price.id} currency must be EUR (got ${price.currency})` }, { status: 500 });
        const priceId = price.id;

        const db = getDB();
        const sub: any = await db.prepare(
            "SELECT stripe_customer_id, stripe_subscription_id, status, early_bird, trial_end FROM subscriptions WHERE user_id = ?"
        ).bind(targetUserId).first();

        // Determine trial config
        const trialEndIso = getStripeEnvOptional("EARLY_BIRD_TRIAL_END") || "2026-08-01T00:00:00Z";
        const trialEndDate = new Date(trialEndIso);
        if (isNaN(trialEndDate.getTime())) {
            return NextResponse.json({ error: `Invalid EARLY_BIRD_TRIAL_END: ${trialEndIso}` }, { status: 500 });
        }
        const trialEndUnix = Math.floor(trialEndDate.getTime() / 1000);
        const nowUnix = Math.floor(Date.now() / 1000);

        // Early bird is ON by default only for Shopify→InvoiceXpress billing
        // (source "faturacao" / empty). Other integrations (Lodgify, Stripe→Moloni)
        // get it only when the per-user flag was explicitly enabled by an admin.
        const isShopifyDefault = !isLodgify && !isStripeMoloni;
        const isEarlyBird = isShopifyDefault || !!sub?.early_bird;
        const useTrial = isEarlyBird && trialEndUnix > nowUnix;

        const SOURCE_PATHS: Record<string, { ok: string; cancel: string }> = {
            "lodgify-moloni": { ok: "/integrations/lodgify-moloni?stripe=success", cancel: "/integrations/lodgify-moloni?stripe=cancel" },
            "stripe-moloni":  { ok: "/integrations/stripe-moloni?stripe=success",  cancel: "/integrations/stripe-moloni?stripe=cancel" },
            "faturacao":      { ok: "/faturacao?stripe=success",                   cancel: "/faturacao?stripe=cancel" },
        };
        const appBaseUrl = new URL(getStripeEnv("SUCCESS_REDIRECT_URL")).origin;
        const paths = SOURCE_PATHS[source] ?? null;
        const successUrl = paths ? `${appBaseUrl}${paths.ok}` : getStripeEnv("SUCCESS_REDIRECT_URL");
        const cancelUrl  = paths ? `${appBaseUrl}${paths.cancel}` : getStripeEnv("CANCEL_REDIRECT_URL");
        const taxRateId = getStripeEnvOptional("STRIPE_TAX_RATE_ID");

        const session = await stripe.checkout.sessions.create({
            mode: "subscription",
            line_items: [{
                price: priceId,
                quantity: 1,
                ...(taxRateId ? { tax_rates: [taxRateId] } : {}),
            }],
            customer: sub?.stripe_customer_id || undefined,
            customer_email: sub?.stripe_customer_id ? undefined : email,
            client_reference_id: targetUserId,
            // Force fixed 23% PT VAT (Stripe Tax automatic would vary by location).
            // With static tax_rate we disable tax_id_collection — collecting EU VAT IDs would mislead B2B
            // customers into expecting reverse-charge (0%), but we apply 23% regardless.
            ...(taxRateId
                ? {}
                : { automatic_tax: { enabled: true }, tax_id_collection: { enabled: true } }
            ),
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
                    app: "rioko",
                    user_id: targetUserId,
                    early_bird: isEarlyBird ? "1" : "0",
                    plan,
                },
                trial_end: useTrial ? trialEndUnix : undefined,
            },
            payment_method_collection: "always",
            metadata: {
                app: "rioko",
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
