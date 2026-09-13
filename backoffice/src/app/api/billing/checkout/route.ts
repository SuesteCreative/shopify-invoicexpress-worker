import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getStripe, getStripeEnv, getStripeEnvOptional, getDB, primaryConnectionKey, EMBEDDED_CHECKOUT_API_VERSION, EMBEDDED_CHECKOUT_UI_MODE } from "@/lib/stripe";
import { resolveAccountUser } from "@/lib/account";
import { RIOKO_CONFIG } from "@/lib/config";
import { resolveReturnPath } from "@/lib/oauth-return";
import { priceLookupFor, resolvePrice, resolveBilling } from "@/lib/billing-prices";
import { addMonths } from "@/lib/referral-reward";
import { REWARD_MONTHS, campaignOpen } from "@/lib/referral";
import { alreadySubscribed } from "@/lib/subscription-state";

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

        // Which connection this subscription pays for (0044), and the price it
        // is sold at, decided together. The key is carried in the subscription's
        // own metadata so the webhook can file the row against the right one — a
        // customer can now hold several, and the events for them are
        // indistinguishable otherwise.
        // A generic page (Billing, dashboard) cannot name a connection, so the
        // account's primary one is used, and the price is read FROM that key.
        // Chosen separately, a Stripe→Moloni account paying from Faturação was
        // filed against its own connection and charged the Shopify product.
        const { connectionKey, source } = await resolveBilling(
            rawSource, body.connection_key, () => primaryConnectionKey(db, targetUserId),
        );

        // Each integration bills its OWN price; an unknown source is rejected
        // rather than silently defaulting to the Shopify one. The map lives in
        // lib/billing-prices so the page that PRINTS the amount reads the same
        // price this charges.
        // Always the current price, including for a client holding an old 5 €/50 €
        // subscription elsewhere: the old plan is inherited on the subscription
        // that already carries it, never sold again on a new integration.
        const lookupOrId = source === null ? null : priceLookupFor(source, plan);
        if (!lookupOrId) {
            return NextResponse.json({ error: `Unknown subscription source: "${source ?? connectionKey}"` }, { status: 400 });
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

        // One subscription per connection. Stripe would happily open a second,
        // parallel one and charge the integration twice; the pages hide the
        // button from a paying client, but a stale tab or a page reading another
        // connection still gets here. alreadySubscribed() says which rows may
        // still check out: an early bird converting, a dead subscription.
        if (alreadySubscribed(sub)) {
            return NextResponse.json({
                error: "Já tens uma subscrição para esta integração. Podes geri-la em Faturação.",
                code: "already_subscribed",
            }, { status: 409 });
        }

        const anySub: any = sub ?? await db.prepare(
            "SELECT stripe_customer_id FROM subscriptions WHERE user_id = ? AND stripe_customer_id IS NOT NULL ORDER BY created_at ASC LIMIT 1"
        ).bind(targetUserId).first();

        // No Stripe trials — every subscription is charged immediately. The
        // early-bird free-access grace (Shopify pilots) is granted BEFORE
        // subscribing by the gate (early_bird flag + trial_end cutoff), never as a
        // Stripe trial. early_bird metadata mirrors the DB flag for reference only.
        const earlyBirdMeta = sub?.early_bird ? "1" : "0";

        // Somebody who arrived through a referral link subscribes with two
        // months on the house. This is the ONLY place that grant exists: it is a
        // real Stripe trial, so Stripe runs the clock and takes the card on its
        // own at the end, and the gate already lets a trial with a subscription
        // id behind it through.
        //
        // An absolute `trial_end`, not `trial_period_days`: two calendar months
        // is 59, 60, 61 or 62 days depending on where in the year it lands, and
        // the terms promise months. A Checkout Session expires within 24 hours,
        // so a date computed here cannot go stale before the form is submitted.
        const referred: any = await db.prepare(
            "SELECT 1 AS ok FROM referrals WHERE invitee_user_id = ? AND state = 'pending'"
        ).bind(targetUserId).first().catch(() => null);
        // After 31 October a pending referral grants nothing. The terms say the
        // subscription must be created inside the campaign, and a row claimed on
        // the 30th must not keep handing out trials in March.
        const referralTrialEnd = referred?.ok && campaignOpen()
            ? Math.floor(new Date(addMonths(new Date().toISOString(), REWARD_MONTHS)).getTime() / 1000)
            : null;

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
        const paths = SOURCE_PATHS[rawSource] ?? null;
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
                    ...(referralTrialEnd ? { referral_role: "invitee" } : {}),
                },
                ...(referralTrialEnd
                    ? {
                        trial_end: referralTrialEnd,
                        // A backstop, not the normal path: the card is collected
                        // below and stays on the subscription. It only matters if
                        // the merchant removes it from the portal mid-trial, and
                        // cancelling is kinder than Stripe's default of invoicing
                        // them into past_due, which the gate reads as blocked.
                        trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
                    }
                    : {}),
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
            // Not on a referral. Two free months and a promotion code on top is
            // two offers stacked, which the campaign terms say does not happen,
            // and this is the only place that could let it.
            ...(referralTrialEnd ? {} : { allow_promotion_codes: true }),
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
