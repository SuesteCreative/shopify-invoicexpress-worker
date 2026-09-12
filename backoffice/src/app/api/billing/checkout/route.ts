import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getStripe, getStripeEnv, getStripeEnvOptional, getDB, primaryConnectionKey, EMBEDDED_CHECKOUT_API_VERSION, EMBEDDED_CHECKOUT_UI_MODE } from "@/lib/stripe";
import { resolveAccountUser } from "@/lib/account";
import { keyFromRequest } from "@/lib/subscription-key";
import { RIOKO_CONFIG } from "@/lib/config";
import { resolveReturnPath } from "@/lib/oauth-return";
import { priceLookupFor, resolvePrice, resolveBillingSource } from "@/lib/billing-prices";

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
            ui_mode?: string; return_slug?: string; locale?: string;
        };
        const plan = body.plan === "annual" ? "annual" : "monthly";
        const rawSource = body.source ?? "";

        // The onboarding pages mount the form inside their own page instead of
        // sending the merchant off to Stripe. Same session, same everything below
        // it: only where the browser goes afterwards changes.
        const embedded = body.ui_mode === "embedded";
        const locale = body.locale === "en" ? "en" : "pt";

        const stripe = getStripe();
        const db = getDB();

        // The dashboard card sits above every integration, so the page cannot say
        // which price to bill. Resolve it from the merchant's own set-up connection
        // (oldest wins when there is more than one); with nothing set up yet, the
        // default Shopify→IX price applies.
        const source = await resolveBillingSource(db, targetUserId, rawSource);

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

        // Each integration bills its OWN price; an unknown source is rejected
        // rather than silently defaulting to the Shopify one. The map lives in
        // lib/billing-prices so the page that PRINTS the amount reads the same
        // price this charges.
        // Always the current price, including for a client holding an old 5 €/50 €
        // subscription elsewhere: the old plan is inherited on the subscription
        // that already carries it, never sold again on a new integration.
        const lookupOrId = priceLookupFor(source, plan);
        if (!lookupOrId) {
            return NextResponse.json({ error: `Unknown subscription source: "${source}"` }, { status: 400 });
        }

        const price: any = await resolvePrice(stripe, lookupOrId);
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

        // Where an embedded form sends the merchant once Stripe is done with them.
        // Through the slug map, never a path from the request: a redirect target
        // that arrives in a body and is obeyed is an open redirect.
        const returnUrl = embedded
            ? `${RIOKO_CONFIG.appUrl}${resolveReturnPath(body.return_slug, locale)}?stripe=return&session_id={CHECKOUT_SESSION_ID}`
            : null;

        // The company name is already on the account by the time anyone reaches
        // the payment step, so it is offered filled in rather than asked again.
        const profile: any = await db
            .prepare("SELECT company_name, name FROM users WHERE id = ?")
            .bind(targetUserId)
            .first();
        const companyDefault = String(profile?.company_name || profile?.name || "").slice(0, 255);

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
            // Stripe does not translate these labels, so the session carries the
            // page's own language for everything around them.
            locale,
            custom_fields: [
                {
                    // Required: it is the name that ends up on the invoice we
                    // issue for the service, and it arrives prefilled from the
                    // account, so it costs a glance rather than typing.
                    key: "company_name",
                    label: { type: "custom", custom: locale === "en" ? "Company name" : "Nome da empresa" },
                    type: "text",
                    optional: false,
                    // The SDK is v14, whose types describe the 2023-10 API; the
                    // version this client pins (2025-01-27.acacia) does take a
                    // default value. Same reason `apiVersion` is cast in lib/stripe.
                    ...(companyDefault ? { text: { default_value: companyDefault } as any } : {}),
                },
                {
                    // Nine digits, enforced in the form. It used to be free text, so
                    // anything could be typed and the webhook quietly dropped what
                    // did not match /^\d{9}$/ — the merchant never learned why their
                    // invoice came out without a NIF.
                    key: "nif",
                    label: { type: "custom", custom: locale === "en" ? "Tax number (optional)" : "NIF (opcional)" },
                    type: "numeric",
                    numeric: { minimum_length: 9, maximum_length: 9 },
                    optional: true,
                },
            ],
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
            // Embedded forbids success_url/cancel_url and wants a return_url; the
            // hosted flow is unchanged.
            ...(embedded
                ? { ui_mode: EMBEDDED_CHECKOUT_UI_MODE as any, return_url: returnUrl! }
                : { success_url: successUrl, cancel_url: cancelUrl }
            ),
            allow_promotion_codes: true,
        },
            // The embedded session is created against a NEWER API version than the
            // one this client pins. The browser SDK mounts embedded Checkout with
            // `createEmbeddedCheckoutPage`, which only understands a session made
            // with `ui_mode: "embedded_page"` — and that value does not exist
            // before this version, while the older `embedded` no longer exists
            // after it. Sent with the older pair, the form mounted as an empty
            // box with nothing in the console. Per request, so every other call in
            // the app stays on the pinned version.
            embedded ? { apiVersion: EMBEDDED_CHECKOUT_API_VERSION } : undefined,
        );

        if (embedded) {
            return NextResponse.json({
                client_secret: session.client_secret,
                id: session.id,
                // A publishable key is meant to reach the browser, and this saves a
                // NEXT_PUBLIC_ variable that would have to be baked into the build.
                publishable_key: getStripeEnvOptional("STRIPE_PUBLIC_KEY") ?? null,
            });
        }

        return NextResponse.json({ url: session.url, id: session.id });
    } catch (e: any) {
        console.error("[Stripe checkout] error", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
