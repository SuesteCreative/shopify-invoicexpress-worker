import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { getStripe, getStripeEnv, getDB, listAccountConnections } from "@/lib/stripe";
import { matchStripeChargeToIX } from "@/lib/invoicexpress-kapta";
import { loadBillingIdentity } from "@/lib/billing-identity";
import { grantSeatFromSession } from "@/lib/seats";
import { notifySubscriptionPaymentFailed } from "@/lib/billing-notify";
import { DEFAULT_CONNECTION_KEY, keyFromRequest, shopIsOldest } from "@/lib/subscription-key";
import { callWorkerJson } from "@/lib/worker";
import { priceBook } from "@/lib/price-book";
import { currentPriceCents, tierOf } from "@/lib/billing-legacy";

export const runtime = "edge";

function isoFromUnix(unix: number | null | undefined): string | null {
    if (!unix) return null;
    return new Date(unix * 1000).toISOString();
}

/** Where a webhook that failed to be handled goes to be seen. */
const OPS_EMAIL = "pedro@kapta.pt";

/**
 * Tell somebody when an event could not be handled.
 *
 * This endpoint answers 200 to Stripe whatever happens, deliberately: a
 * persistent bug is not fixed by retries, and the event id is already recorded.
 * The cost of that choice is silence, and silence is what let a wrong bind count
 * refuse every subscription renewal and cancellation for days with Stripe
 * reporting success on all of them. Best effort, never in the way of the 200.
 */
async function alertHandlerError(event: Stripe.Event, err: any): Promise<void> {
    await callWorkerJson("/admin/notify", {
        method: "POST",
        body: JSON.stringify({
            recipients: [OPS_EMAIL],
            subject: `[Rioko] webhook do Stripe falhou: ${event.type}`,
            body: [
                `Evento: ${event.type}`,
                `Id: ${event.id}`,
                `Erro: ${err?.message ?? String(err)}`,
                "",
                "O endpoint respondeu 200 à mesma, portanto o Stripe não volta a tentar.",
                "Nada foi escrito na base de dados para este evento.",
            ].join("\n"),
            from_name: "Rioko Billing",
        }),
    });
}

// Rioko users are provisioned by Clerk and always have an id that starts with
// "user_". Any other reference (e.g. a Stripe "acct_" id arriving on this shared
// webhook from an unrelated Connect checkout) must NEVER be treated as a Rioko
// user — otherwise we create phantom accounts and bill-match unrelated payments.
function isRiokoUserId(id: string | null | undefined): id is string {
    return !!id && id.startsWith("user_");
}

// When a user's subscription becomes paid/active, release anything that was paused
// pending payment: (1) new-model connections (stamping the subscription start as
// the invoice cutoff), and (2) the legacy integrations row's is_paused flag (e.g. a
// Shopify merchant suspended for non-payment). Both are idempotent — 0 rows matched
// when nothing was paused. First activation wins the cutoff; re-runs never overwrite.
async function activatePausedConnections(db: D1Database, userId: string, cutoffIso: string | null) {
    await db.prepare(
        `UPDATE connections SET status='active', invoice_cutoff=?, updated_at=CURRENT_TIMESTAMP
         WHERE user_id=? AND status='paused'`
    ).bind(cutoffIso, userId).run();

    // A connection built AFTER the payment is never 'paused' — the wizard
    // activates it on the spot — so the branch above never touched it and its
    // cutoff stayed NULL. Everything downstream then falls back to the row's
    // created_at, which is "the day somebody ran the wizard" and not "the day
    // this client started paying"; on the Alliance connection those were the
    // same afternoon, and the difference is which sales are ours to issue.
    // Only NULLs are filled: a date an admin set by hand must survive every
    // renewal webhook that follows.
    if (cutoffIso) {
        await db.prepare(
            `UPDATE connections SET invoice_cutoff=?, updated_at=CURRENT_TIMESTAMP
             WHERE user_id=? AND status='active' AND invoice_cutoff IS NULL`
        ).bind(cutoffIso, userId).run();
    }
    await db.prepare(
        `UPDATE integrations SET is_paused=0, updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND is_paused=1`
    ).bind(userId).run();
}

/**
 * Which connection a Stripe subscription pays for.
 *
 * Checkouts started after 0044 say so in the subscription's own metadata. The
 * ones that came before say nothing, so the row we already wrote for that
 * subscription id answers instead — that is where the migration's attribution
 * lives, and a renewal must not move a subscription to a different connection.
 * Only a genuinely new, metadata-less subscription falls through to the default.
 */
async function resolveConnectionKey(db: D1Database, userId: string, sub: Stripe.Subscription | null): Promise<string> {
    // Metadata is trusted only when it names a connection the account HAS.
    // Checkouts started from a generic page stamped `shopify:invoicexpress` on
    // every account regardless, so a merchant running only Lodgify->IX had the
    // payment filed against a connection that does not exist, and the page kept
    // reading the real one as unpaid. An account with nothing set up yet has
    // nothing better to go on, so there the metadata still wins.
    const fromMetadata = String(sub?.metadata?.connection_key ?? "").trim();
    if (fromMetadata.includes(":")) {
        const accountKeys = (await listAccountConnections(db, userId)).map((c) => c.key);
        if (accountKeys.length === 0 || accountKeys.includes(fromMetadata)) return fromMetadata;
    }

    if (sub?.id) {
        const existing: any = await db.prepare(
            "SELECT connection_key FROM subscriptions WHERE stripe_subscription_id = ? LIMIT 1"
        ).bind(sub.id).first();
        if (existing?.connection_key) return existing.connection_key;
    }

    // Same rule the migration used: the connection the account set up first is
    // the one an unattributed subscription was bought for.
    const conn: any = await db.prepare(
        "SELECT source_kind, destination_kind FROM connections WHERE user_id = ? ORDER BY created_at ASC LIMIT 1"
    ).bind(userId).first();
    const shop: any = await db.prepare(
        "SELECT created_at FROM integrations WHERE user_id = ? AND shopify_domain IS NOT NULL AND shopify_domain <> '' LIMIT 1"
    ).bind(userId).first();
    if (shop && shopIsOldest(shop.created_at, conn?.created_at)) return DEFAULT_CONNECTION_KEY;
    if (conn) return `${conn.source_kind}:${conn.destination_kind}`;
    return DEFAULT_CONNECTION_KEY;
}

async function upsertSubscriptionFromStripeSub(db: D1Database, userId: string, sub: Stripe.Subscription) {
    const item = sub.items.data[0];
    const priceId = item?.price?.id || null;
    const plan = (sub.metadata?.plan as string) || (item?.price?.recurring?.interval === "year" ? "annual" : "monthly");
    const earlyBird = sub.metadata?.early_bird === "1" ? 1 : 0;
    const connectionKey = await resolveConnectionKey(db, userId, sub);

    await db.prepare(`
        INSERT INTO subscriptions (user_id, connection_key, stripe_customer_id, stripe_subscription_id, status,
                                   plan, price_id, current_period_end, trial_end,
                                   cancel_at_period_end, cancel_at, early_bird, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, connection_key) DO UPDATE SET
            stripe_customer_id = excluded.stripe_customer_id,
            stripe_subscription_id = excluded.stripe_subscription_id,
            status = excluded.status,
            plan = excluded.plan,
            price_id = excluded.price_id,
            current_period_end = excluded.current_period_end,
            -- Rioko never uses Stripe trials (access is granted by our own gate), so
            -- Stripe reports trial_end = NULL and this used to WIPE an admin-set
            -- early-bird date — which the next /api/integrations save then replaced
            -- with the default cutoff. Refuse the NULL when the row is admin-owned;
            -- a real Stripe trial still wins.
            trial_end = CASE WHEN subscriptions.admin_override_at IS NOT NULL AND excluded.trial_end IS NULL
                             THEN subscriptions.trial_end ELSE excluded.trial_end END,
            cancel_at_period_end = excluded.cancel_at_period_end,
            -- The fixed end date, when there is one: a legacy monthly is ended
            -- with cancel_at, which leaves cancel_at_period_end false.
            cancel_at = excluded.cancel_at,
            -- early_bird is OWNED by our DB (set by onboarding / admin / migration),
            -- never by stale Stripe metadata. Preserve it on every webhook so an
            -- admin who turns it off isn't reverted to 1 by the next sub event.
            early_bird = subscriptions.early_bird,
            updated_at = CURRENT_TIMESTAMP
    `).bind(
        userId,
        // Second, because it is the second column and the second `?`. It was
        // computed above and never bound when the connection key was added
        // (a19f25d): eleven placeholders, ten values, so D1 refused EVERY
        // customer.subscription.* event from that commit until this one. New
        // subscriptions kept appearing because they arrive through the
        // checkout.session.completed upsert below, which was bound correctly —
        // renewals, cancellations, plan changes and current_period_end simply
        // stopped reaching the database.
        connectionKey,
        typeof sub.customer === "string" ? sub.customer : sub.customer.id,
        sub.id,
        sub.status,
        plan,
        priceId,
        isoFromUnix((sub as any).current_period_end),
        isoFromUnix(sub.trial_end),
        sub.cancel_at_period_end ? 1 : 0,
        isoFromUnix((sub as any).cancel_at),
        earlyBird,
    ).run();
}

/**
 * Tell a client on the old price that this renewal is the last one.
 *
 * Only for a subscription already marked to stop — `cancel_at_period_end` on an
 * annual, `cancel_at` on a monthly — so it never announces an ending that is not
 * happening. Once per end date: the marker is per ROW, unlike the two older
 * reminder markers, which stamp every subscription an account has.
 */
async function noticeLegacyEnding(db: D1Database, stripe: Stripe, subscriptionId: string): Promise<void> {
    const row: any = await db
        .prepare(
            `SELECT s.user_id, s.connection_key, s.plan, s.price_id, s.current_period_end,
                    s.cancel_at, s.cancel_at_period_end, s.legacy_notice_sent_for,
                    COALESCE(s.email, u.email) AS to_email,
                    COALESCE(s.name, u.company_name, u.admin_label, u.name) AS label
               FROM subscriptions s LEFT JOIN users u ON u.id = s.user_id
              WHERE s.stripe_subscription_id = ? LIMIT 1`
        )
        .bind(subscriptionId)
        .first()
        .catch(() => null);

    const ending = !!row && (Number(row.cancel_at_period_end) === 1 || !!row.cancel_at);
    if (!ending || !row.to_email) return;

    const price = row.price_id ? (await priceBook()).get(row.price_id) : null;
    if (tierOf(price) !== "legacy") return;

    const interval = price?.recurring?.interval ?? (row.plan === "annual" ? "year" : "month");
    const endsAt = row.cancel_at ?? row.current_period_end;
    if (!endsAt) return;

    const marker = `${endsAt}#ending`;
    if (row.legacy_notice_sent_for === marker) return;

    const res = await callWorkerJson("/admin/legacy-price-email", {
        method: "POST",
        body: JSON.stringify({
            stage: "ending",
            to: row.to_email,
            name: row.label ?? null,
            ends_at: endsAt,
            interval,
            current_amount_cents: price?.unit_amount ?? null,
            next_amount_cents: currentPriceCents(interval),
            user_id: row.user_id,
        }),
    }).catch(() => ({ ok: false }));

    if ((res as any).ok) {
        await db
            .prepare(
                `UPDATE subscriptions SET legacy_notice_sent_for = ?, updated_at = CURRENT_TIMESTAMP
                  WHERE user_id = ? AND connection_key = ?`
            )
            .bind(marker, row.user_id, row.connection_key)
            .run();
    }
}

export async function POST(req: NextRequest) {
    const sig = (await headers()).get("stripe-signature");
    if (!sig) return new Response("Missing signature", { status: 400 });

    const body = await req.text();
    const stripe = getStripe();
    const secret = getStripeEnv("STRIPE_WEBHOOK_SECRET");

    let event: Stripe.Event;
    try {
        event = await stripe.webhooks.constructEventAsync(body, sig, secret);
    } catch (e: any) {
        console.error("[Stripe webhook] signature verify failed", e.message);
        return new Response(`Webhook Error: ${e.message}`, { status: 400 });
    }

    // This endpoint serves ONLY Rioko's own platform subscription billing. Events
    // that originate from a connected account belong to a different product /
    // unrelated payments and must never reach the handlers below.
    if ((event as any).account) {
        console.warn(`[Stripe webhook] Ignoring event ${event.id} from connected account ${(event as any).account}`);
        return NextResponse.json({ received: true, ignored: "connected_account" });
    }

    const db = getDB();

    // Idempotency
    const existing: any = await db.prepare("SELECT id FROM billing_events WHERE id = ?").bind(event.id).first();
    if (existing && event.type !== "checkout.session.completed") {
        // checkout.session.completed re-runs are safe because of upsert; for other events skip on dupe
        return NextResponse.json({ received: true, duplicate: true });
    }

    try {
        switch (event.type) {
            case "checkout.session.completed": {
                const session = event.data.object as Stripe.Checkout.Session;

                // A one-off seat purchase, not a subscription: grant the seat and
                // stop. Keyed on the session id, so the browser confirming on its
                // way back and this webhook cannot both hand out a seat.
                if (session.metadata?.kind === "extra_user_seat") {
                    // Completed is not paid. A delayed payment method completes
                    // the session first and settles later, which would hand out
                    // a seat for money that never arrives — the browser's
                    // confirm path has always checked this; this one did not.
                    if (session.payment_status !== "paid") {
                        console.warn(`[Stripe webhook] seat session ${session.id} is ${session.payment_status}, not granting`);
                        break;
                    }
                    const { granted, accountId } = await grantSeatFromSession(db, session as any);
                    console.log(`[Stripe webhook] seat for ${accountId}: ${granted ? "granted" : "already granted"}`);
                    await db.prepare(
                        "INSERT OR IGNORE INTO billing_events (id, user_id, type, stripe_object_id, raw_json) VALUES (?, ?, ?, ?, ?)"
                    ).bind(event.id, accountId, event.type, session.id, JSON.stringify({ kind: "extra_user_seat" })).run();
                    break;
                }

                const userId = session.client_reference_id || (session.metadata?.user_id as string);
                if (!userId) {
                    console.error("[Stripe webhook] checkout.session.completed without user_id");
                    break;
                }
                if (!isRiokoUserId(userId)) {
                    console.warn(`[Stripe webhook] Ignoring checkout.session.completed for non-Rioko reference "${userId}" (session ${session.id})`);
                    break;
                }

                // Ensure users row exists (defensive against Clerk race)
                const userExists: any = await db.prepare("SELECT id FROM users WHERE id = ?").bind(userId).first();
                if (!userExists) {
                    await db.prepare(
                        "INSERT OR IGNORE INTO users (id, email, name, last_login) VALUES (?, ?, ?, CURRENT_TIMESTAMP)"
                    ).bind(userId, session.customer_details?.email || null, session.customer_details?.name || "User").run();
                }

                const rawNif = session.custom_fields?.find(f => f.key === "nif")?.text?.value?.trim() || null;
                // PT NIF: exactly 9 digits. Reject anything else (free-text "abc", phone numbers, etc.)
                const nif = rawNif && /^\d{9}$/.test(rawNif) ? rawNif : null;
                if (rawNif && !nif) {
                    console.warn(`[Stripe webhook] Invalid NIF rejected: "${rawNif}" for user ${userId}`);
                }
                const details = session.customer_details;
                const addr = details?.address;

                // Update customer metadata. Always include user_id; only set fiscal_id if NIF provided.
                const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
                if (customerId) {
                    const customerMetadata: Record<string, string> = { user_id: userId };
                    if (nif) customerMetadata.fiscal_id = nif;
                    await stripe.customers.update(customerId, { metadata: customerMetadata });
                }

                // Pull subscription
                let sub: Stripe.Subscription | null = null;
                if (session.subscription) {
                    const subId = typeof session.subscription === "string" ? session.subscription : session.subscription.id;
                    sub = await stripe.subscriptions.retrieve(subId);
                    // Also mirror fiscal_id on subscription metadata so it propagates onto invoices
                    if (nif) {
                        await stripe.subscriptions.update(sub.id, {
                            metadata: { ...(sub.metadata || {}), fiscal_id: nif, user_id: userId },
                        });
                    }
                }

                // The session says which connection was being paid for; the
                // subscription's metadata carries the same value for the renewals
                // that follow. Both go through the same check as every other
                // event: a key naming a connection the account does not have is
                // not attribution, it is the old generic-page default.
                const claimedKey = keyFromRequest(
                    (sub?.metadata?.connection_key as string) ?? (session.metadata?.connection_key as string),
                    session.metadata?.source as string,
                );
                const accountKeys = (await listAccountConnections(db, userId)).map((c) => c.key);
                const connectionKey = accountKeys.length === 0 || accountKeys.includes(claimedKey)
                    ? claimedKey
                    : await resolveConnectionKey(db, userId, sub);

                await db.prepare(`
                    INSERT INTO subscriptions (
                        user_id, connection_key, stripe_customer_id, stripe_subscription_id, status,
                        plan, price_id, current_period_end, trial_end,
                        cancel_at_period_end, nif, name, email, phone,
                        address, city, zip, country, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(user_id, connection_key) DO UPDATE SET
                        stripe_customer_id = excluded.stripe_customer_id,
                        stripe_subscription_id = excluded.stripe_subscription_id,
                        status = excluded.status,
                        plan = excluded.plan,
                        price_id = excluded.price_id,
                        current_period_end = excluded.current_period_end,
                        -- Same as upsertSubscriptionFromStripeSub: a NULL Stripe
                        -- trial_end must not erase an admin-set early-bird date.
                        trial_end = CASE WHEN subscriptions.admin_override_at IS NOT NULL AND excluded.trial_end IS NULL
                                         THEN subscriptions.trial_end ELSE excluded.trial_end END,
                        cancel_at_period_end = excluded.cancel_at_period_end,
                        nif = COALESCE(excluded.nif, subscriptions.nif),
                        name = COALESCE(excluded.name, subscriptions.name),
                        email = COALESCE(excluded.email, subscriptions.email),
                        phone = COALESCE(excluded.phone, subscriptions.phone),
                        address = COALESCE(excluded.address, subscriptions.address),
                        city = COALESCE(excluded.city, subscriptions.city),
                        zip = COALESCE(excluded.zip, subscriptions.zip),
                        country = COALESCE(excluded.country, subscriptions.country),
                        updated_at = CURRENT_TIMESTAMP
                `).bind(
                    userId,
                    connectionKey,
                    customerId || null,
                    sub?.id || null,
                    sub?.status || "incomplete",
                    (sub?.metadata?.plan as string) || null,
                    sub?.items?.data?.[0]?.price?.id || null,
                    isoFromUnix((sub as any)?.current_period_end),
                    isoFromUnix(sub?.trial_end),
                    sub?.cancel_at_period_end ? 1 : 0,
                    nif,
                    details?.name || null,
                    details?.email || null,
                    details?.phone || null,
                    addr?.line1 || null,
                    addr?.city || null,
                    addr?.postal_code || null,
                    addr?.country || null,
                ).run();

                // First paid activation: release the connection that was paused
                // pending payment and stamp the subscription start as the cutoff
                // (bookings created before it are never invoiced retroactively).
                if (sub?.status === "active") {
                    await activatePausedConnections(db, userId, isoFromUnix((sub as any)?.start_date));
                }

                // Mark event processed
                await db.prepare(
                    "INSERT OR IGNORE INTO billing_events (id, user_id, type, stripe_object_id, raw_json) VALUES (?, ?, ?, ?, ?)"
                ).bind(event.id, userId, event.type, session.id, JSON.stringify(session)).run();
                break;
            }

            case "customer.subscription.created":
            case "customer.subscription.updated":
            case "customer.subscription.deleted": {
                const sub = event.data.object as Stripe.Subscription;
                const userId = (sub.metadata?.user_id as string) || await resolveUserIdFromCustomer(db, stripe, sub.customer);
                if (!userId) {
                    console.error("[Stripe webhook] sub event with no user_id", event.id);
                    break;
                }
                if (!isRiokoUserId(userId)) {
                    console.warn(`[Stripe webhook] Ignoring ${event.type} for non-Rioko reference "${userId}" (${event.id})`);
                    break;
                }
                await upsertSubscriptionFromStripeSub(db, userId, sub);
                // Release a connection paused pending payment on the first active sub.
                if (sub.status === "active") {
                    await activatePausedConnections(db, userId, isoFromUnix((sub as any).start_date));
                }
                await db.prepare(
                    "INSERT OR IGNORE INTO billing_events (id, user_id, type, stripe_object_id, raw_json) VALUES (?, ?, ?, ?, ?)"
                ).bind(event.id, userId, event.type, sub.id, JSON.stringify(sub)).run();
                break;
            }

            // Stripe's own reminder that a renewal is coming, days ahead. For a
            // subscription already marked to stop, that renewal is not coming:
            // this is the moment to say so, and it costs no scheduler of ours.
            case "invoice.upcoming": {
                const inv = event.data.object as Stripe.Invoice;
                const subId = typeof (inv as any).subscription === "string"
                    ? (inv as any).subscription
                    : (inv as any).subscription?.id;
                if (!subId) break;
                await noticeLegacyEnding(db, stripe, subId);
                break;
            }

            case "invoice.paid":
            case "invoice.payment_failed": {
                const invoice = event.data.object as Stripe.Invoice;
                const userId = (invoice.subscription_details?.metadata?.user_id as string)
                    || (invoice.metadata?.user_id as string)
                    || await resolveUserIdFromCustomer(db, stripe, invoice.customer);
                if (!userId) {
                    console.error("[Stripe webhook] invoice event with no user_id", event.id);
                    break;
                }
                if (!isRiokoUserId(userId)) {
                    console.warn(`[Stripe webhook] Ignoring ${event.type} for non-Rioko reference "${userId}" (${event.id})`);
                    break;
                }

                const pi = (invoice as any).payment_intent;
                const piId = typeof pi === "string" ? pi : pi?.id;

                // Insert billing_event first (idempotent)
                const insert = await db.prepare(`
                    INSERT OR IGNORE INTO billing_events (
                        id, user_id, type, stripe_object_id, payment_intent_id,
                        amount_cents, currency, status, raw_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).bind(
                    event.id,
                    userId,
                    event.type,
                    invoice.id,
                    piId || null,
                    invoice.amount_paid || invoice.amount_due || 0,
                    invoice.currency || "eur",
                    invoice.status || (event.type === "invoice.paid" ? "paid" : "failed"),
                    JSON.stringify(invoice),
                ).run();

                // A charge that failed on a live subscription is the one billing
                // event only the client can fix, and Stripe tells nobody but us.
                // Mail them the link that fixes it — once per distinct failed
                // attempt, and never again when Stripe re-delivers the same event
                // (the INSERT OR IGNORE above changed no rows the second time).
                const firstDelivery = ((insert as any)?.meta?.changes ?? 0) > 0;
                if (event.type === "invoice.payment_failed" && firstDelivery) {
                    try {
                        const notice = await notifySubscriptionPaymentFailed({
                            db, stripe, userId, invoice, origin: new URL(req.url).origin,
                        });
                        console.log(
                            `[Stripe webhook] payment_failed notice for ${invoice.id}: ` +
                            (notice.sent ? `sent to ${notice.recipients?.join(", ")}` : `skipped (${notice.reason})`)
                        );
                    } catch (mailErr: any) {
                        // Best effort: a mail failure must not make us 500 and have
                        // Stripe re-deliver an event we already recorded.
                        console.error(`[Stripe webhook] payment_failed notice error for ${event.id}: ${mailErr.message}`);
                    }
                }

                // For paid invoices: try IX matching. Errors here MUST NOT bubble (cron retries).
                if (event.type === "invoice.paid" && piId) {
                    try {
                        const sub = await loadBillingIdentity(db, userId);
                        const match = await matchStripeChargeToIX({
                            payment_intent_id: piId,
                            invoice_number: invoice.number || null,
                            candidate: {
                                nif: sub?.nif || invoice.customer_tax_ids?.[0]?.value || null,
                                email: sub?.email || invoice.customer_email || null,
                                name: sub?.name || invoice.customer_name || null,
                                address: sub?.address || invoice.customer_address?.line1 || null,
                                zip: sub?.zip || invoice.customer_address?.postal_code || null,
                                amount_cents: invoice.amount_paid || 0,
                                paid_at: new Date((invoice.status_transitions?.paid_at || Date.now() / 1000) * 1000),
                            },
                        });

                        if (match.ix_invoice_id) {
                            await db.prepare(`
                                UPDATE billing_events
                                SET ix_invoice_id = ?, ix_invoice_permalink = ?, ix_match_method = ?, ix_match_score = ?
                                WHERE id = ?
                            `).bind(match.ix_invoice_id, match.ix_invoice_permalink, match.ix_match_method, match.ix_match_score, event.id).run();
                        }
                    } catch (ixErr: any) {
                        console.error(`[Stripe webhook] IX match failed for ${event.id} — cron will retry: ${ixErr.message}`);
                    }
                }
                break;
            }

            case "charge.refunded": {
                const charge = event.data.object as Stripe.Charge;
                const userId = await resolveUserIdFromCustomer(db, stripe, charge.customer);
                if (!userId) {
                    console.error("[Stripe webhook] charge.refunded with no user_id", event.id);
                    break;
                }
                if (!isRiokoUserId(userId)) {
                    console.warn(`[Stripe webhook] Ignoring charge.refunded for non-Rioko reference "${userId}" (${event.id})`);
                    break;
                }

                const piId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
                const refundAmount = charge.amount_refunded || 0;
                const latestRefund = charge.refunds?.data?.[0];

                await db.prepare(`
                    INSERT OR IGNORE INTO billing_events (
                        id, user_id, type, stripe_object_id, payment_intent_id,
                        amount_cents, currency, status, raw_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).bind(
                    event.id,
                    userId,
                    event.type,
                    latestRefund?.id || charge.id,
                    piId || null,
                    refundAmount,
                    charge.currency || "eur",
                    "refunded",
                    JSON.stringify(charge),
                ).run();

                // Try to match IX credit note for this refund
                try {
                    const subRow = await loadBillingIdentity(db, userId);
                    const match = await matchStripeChargeToIX({
                        payment_intent_id: piId,
                        doc_type: "credit_note",
                        extra_refs: latestRefund?.id ? [latestRefund.id, `re_${latestRefund.id.replace(/^re_/, "")}`] : [],
                        candidate: {
                            nif: subRow?.nif || null,
                            email: subRow?.email || charge.billing_details?.email || null,
                            name: subRow?.name || charge.billing_details?.name || null,
                            address: subRow?.address || charge.billing_details?.address?.line1 || null,
                            zip: subRow?.zip || charge.billing_details?.address?.postal_code || null,
                            amount_cents: refundAmount,
                            paid_at: new Date(charge.created * 1000),
                        },
                    });
                    if (match.ix_invoice_id) {
                        await db.prepare(`
                            UPDATE billing_events
                            SET ix_invoice_id = ?, ix_invoice_permalink = ?, ix_match_method = ?, ix_match_score = ?
                            WHERE id = ?
                        `).bind(match.ix_invoice_id, match.ix_invoice_permalink, match.ix_match_method, match.ix_match_score, event.id).run();
                    }
                } catch (ixErr: any) {
                    console.error(`[Stripe webhook] IX credit note match failed for ${event.id} — cron will retry: ${ixErr.message}`);
                }
                break;
            }

            case "customer.subscription.trial_will_end": {
                // Optional: send email notification
                console.log("[Stripe webhook] trial_will_end", event.id);
                break;
            }

            default:
                console.log(`[Stripe webhook] unhandled event ${event.type}`);
        }
    } catch (err: any) {
        console.error(`[Stripe webhook] handler error for ${event.type}`, err);
        // Return 200 anyway: we've recorded the event_id in billing_events (idempotency),
        // and Stripe retrying won't help with persistent bugs. Cron retries IX matching.
        // Only signature/parse failures above this catch return 400.
        //
        // But say so out loud. Swallowing this in a console nobody reads is how a
        // wrong bind count in the subscription upsert refused every renewal and
        // cancellation for days while Stripe showed 200s all the way.
        await alertHandlerError(event, err).catch(() => { /* the 200 matters more */ });
        return NextResponse.json({ received: true, handler_error: err.message });
    }

    return NextResponse.json({ received: true });
}

async function resolveUserIdFromCustomer(db: D1Database, stripe: Stripe, customer: string | Stripe.Customer | Stripe.DeletedCustomer | null): Promise<string | null> {
    if (!customer) return null;
    const customerId = typeof customer === "string" ? customer : customer.id;

    // Try DB lookup
    const row: any = await db.prepare("SELECT user_id FROM subscriptions WHERE stripe_customer_id = ?").bind(customerId).first();
    if (row?.user_id) return row.user_id;

    // Fallback to Stripe customer metadata
    try {
        const c = await stripe.customers.retrieve(customerId);
        if (!c.deleted && c.metadata?.user_id) return c.metadata.user_id;
    } catch { }
    return null;
}
