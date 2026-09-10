import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getStripe, getStripeEnv, getStripeEnvOptional, getDB, primaryConnectionKey } from "@/lib/stripe";
import { resolveAccountUser } from "@/lib/account";
import { CONNECTION_KEY_TO_SOURCE, keyFromRequest } from "@/lib/subscription-key";

export const runtime = "edge";

export async function POST(req: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        // Checkout subscribes the ACCOUNT: the impersonated user for an admin, the
        // inviting account for an extra user (0039), otherwise the caller.
        const targetUserId = await resolveAccountUser(req, userId);
        let targetEmail: string | null = null;
        if (targetUserId !== userId) {
            const db0 = getDB();
            const u: any = await db0.prepare("SELECT email FROM users WHERE id = ?").bind(targetUserId).first();
            targetEmail = u?.email || null;
        }

        if (!targetEmail) {
            const user = await currentUser();
            targetEmail = user?.emailAddresses?.[0]?.emailAddress || null;
        }
        if (!targetEmail) return NextResponse.json({ error: "No email for target user" }, { status: 400 });
        const email = targetEmail;

        const body = (await req.json().catch(() => ({}))) as {
            plan?: "monthly" | "annual"; source?: string; connection_key?: string;
        };
        const plan = body.plan === "annual" ? "annual" : "monthly";
        const rawSource = body.source ?? "";

        const stripe = getStripe();
        const db = getDB();

        // The dashboard card sits above every integration, so the page cannot say
        // which price to bill. Resolve it from the merchant's own set-up connection
        // (oldest wins when there is more than one); with nothing set up yet, the
        // default Shopify→IX price applies.
        let source = rawSource;
        if (rawSource === "dashboard") {
            const conn: any = await db.prepare(
                "SELECT source_kind, destination_kind FROM connections WHERE user_id = ? AND status IN ('active','paused') ORDER BY created_at ASC LIMIT 1"
            ).bind(targetUserId).first();
            source = (conn && CONNECTION_KEY_TO_SOURCE[`${conn.source_kind}:${conn.destination_kind}`]) || "faturacao";
        }

        // Which connection this subscription pays for (0044). Carried in the
        // subscription's own metadata so the webhook can file the row against
        // the right one — a customer can now hold several, and the events for
        // them are indistinguishable otherwise.
        // A generic page (Billing, dashboard) cannot name a connection, and the
        // static map answers "shopify:invoicexpress" for all of them. On an
        // account whose only connection is another pair that key names nothing:
        // the payment is filed against a connection that does not exist and the
        // billing page keeps reading "inactive" for the one that does. Resolve
        // it from the account instead. An explicit key still wins.
        const GENERIC_SOURCES = new Set(["", "faturacao", "dashboard"]);
        const connectionKey = body.connection_key
            ? keyFromRequest(body.connection_key, null)
            : GENERIC_SOURCES.has(rawSource)
                ? await primaryConnectionKey(db, targetUserId)
                : keyFromRequest(null, source);

        // Each integration bills its OWN price. Explicit source → lookup mapping;
        // an unknown source is rejected (400) rather than silently defaulting to the
        // Shopify price. Lookups resolve lazily so a missing env var only affects the
        // source that needs it. (stripe-moloni / stripe-ix keys are stable literals.)
        let lookupOrId: string;
        switch (source) {
            case "":
            case "faturacao":
            // Lodgify->IX bills the same product at the same price as Shopify->IX.
            // Only the connection it pays for differs.
            case "lodgify-ix":
                lookupOrId = plan === "annual" ? getStripeEnv("STRIPE_PRICE_YEARLY_LOOKUP") : getStripeEnv("STRIPE_PRICE_MONTHLY_LOOKUP");
                break;
            case "lodgify-moloni":
                lookupOrId = plan === "annual" ? getStripeEnv("STRIPE_PRICE_LODGIFY_YEARLY_LOOKUP") : getStripeEnv("STRIPE_PRICE_LODGIFY_MONTHLY_LOOKUP");
                break;
            case "stripe-moloni":
                lookupOrId = plan === "annual" ? "stripe-moloni-yearly" : "stripe-moloni-monthly";
                break;
            // Connect has its own product, at the price the onboarding page
            // advertises: 7,50 € a month and 75 € a year. It used to bill the
            // Stripe→Moloni pair, where the monthly price does not exist at all
            // (every click answered "Price not found") and the yearly one is an
            // older 50 €.
            case "stripe-connect-moloni":
                lookupOrId = plan === "annual" ? "stripe-connect-moloni-yearly" : "stripe-connect-moloni-monthly";
                break;
            case "stripe-ix":
            // Same product as Stripe Legacy → IX; only the connection differs.
            case "stripe-connect-ix":
                lookupOrId = plan === "annual" ? "stripe-ix-yearly" : "stripe-ix-monthly";
                break;
            default:
                return NextResponse.json({ error: `Unknown subscription source: "${source}"` }, { status: 400 });
        }

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

        // The customer id is the account's (one Stripe customer, several
        // subscriptions); early_bird belongs to the row of THIS connection.
        const sub: any = await db.prepare(
            "SELECT stripe_customer_id, stripe_subscription_id, status, early_bird, trial_end FROM subscriptions WHERE user_id = ? AND connection_key = ?"
        ).bind(targetUserId, connectionKey).first();
        const anySub: any = sub ?? await db.prepare(
            "SELECT stripe_customer_id FROM subscriptions WHERE user_id = ? AND stripe_customer_id IS NOT NULL ORDER BY created_at ASC LIMIT 1"
        ).bind(targetUserId).first();

        // No Stripe trials — every subscription is charged immediately. The
        // early-bird free-access grace (Shopify pilots) is granted BEFORE
        // subscribing by the gate (early_bird flag + trial_end cutoff), never as a
        // Stripe trial. early_bird metadata mirrors the DB flag for reference only.
        const earlyBirdMeta = sub?.early_bird ? "1" : "0";

        const SOURCE_PATHS: Record<string, { ok: string; cancel: string }> = {
            "lodgify-moloni": { ok: "/integrations/lodgify-moloni?stripe=success", cancel: "/integrations/lodgify-moloni?stripe=cancel" },
            "stripe-moloni":  { ok: "/integrations/stripe-moloni?stripe=success",  cancel: "/integrations/stripe-moloni?stripe=cancel" },
            "stripe-connect-moloni": { ok: "/integrations/stripe-connect-moloni?stripe=success", cancel: "/integrations/stripe-connect-moloni?stripe=cancel" },
            "stripe-connect-ix": { ok: "/integrations/stripe-connect-ix?stripe=success", cancel: "/integrations/stripe-connect-ix?stripe=cancel" },
            "lodgify-ix":     { ok: "/integrations/lodgify-ix?stripe=success",     cancel: "/integrations/lodgify-ix?stripe=cancel" },
            "faturacao":      { ok: "/faturacao?stripe=success",                   cancel: "/faturacao?stripe=cancel" },
            "dashboard":      { ok: "/dashboard?stripe=success",                   cancel: "/dashboard?stripe=cancel" },
        };
        const appBaseUrl = new URL(getStripeEnv("SUCCESS_REDIRECT_URL")).origin;
        // Come back where the merchant clicked, not where the price came from.
        const paths = SOURCE_PATHS[rawSource] ?? SOURCE_PATHS[source] ?? null;
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
            customer: anySub?.stripe_customer_id || undefined,
            customer_email: anySub?.stripe_customer_id ? undefined : email,
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
                    early_bird: earlyBirdMeta,
                    plan,
                    connection_key: connectionKey,
                },
            },
            payment_method_collection: "always",
            metadata: {
                app: "rioko",
                user_id: targetUserId,
                plan,
                early_bird: earlyBirdMeta,
                connection_key: connectionKey,
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
