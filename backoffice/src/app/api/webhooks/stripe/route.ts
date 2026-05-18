import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { getStripe, getStripeEnv, getDB } from "@/lib/stripe";
import { matchStripeChargeToIX } from "@/lib/invoicexpress-kapta";

export const runtime = "edge";

function isoFromUnix(unix: number | null | undefined): string | null {
    if (!unix) return null;
    return new Date(unix * 1000).toISOString();
}

async function upsertSubscriptionFromStripeSub(db: D1Database, userId: string, sub: Stripe.Subscription) {
    const item = sub.items.data[0];
    const priceId = item?.price?.id || null;
    const plan = (sub.metadata?.plan as string) || (item?.price?.recurring?.interval === "year" ? "annual" : "monthly");
    const earlyBird = sub.metadata?.early_bird === "1" ? 1 : 0;

    await db.prepare(`
        INSERT INTO subscriptions (user_id, stripe_customer_id, stripe_subscription_id, status,
                                   plan, price_id, current_period_end, trial_end,
                                   cancel_at_period_end, early_bird, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET
            stripe_customer_id = excluded.stripe_customer_id,
            stripe_subscription_id = excluded.stripe_subscription_id,
            status = excluded.status,
            plan = excluded.plan,
            price_id = excluded.price_id,
            current_period_end = excluded.current_period_end,
            trial_end = excluded.trial_end,
            cancel_at_period_end = excluded.cancel_at_period_end,
            early_bird = CASE WHEN excluded.early_bird = 1 THEN 1 ELSE subscriptions.early_bird END,
            updated_at = CURRENT_TIMESTAMP
    `).bind(
        userId,
        typeof sub.customer === "string" ? sub.customer : sub.customer.id,
        sub.id,
        sub.status,
        plan,
        priceId,
        isoFromUnix((sub as any).current_period_end),
        isoFromUnix(sub.trial_end),
        sub.cancel_at_period_end ? 1 : 0,
        earlyBird,
    ).run();
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
                const userId = session.client_reference_id || (session.metadata?.user_id as string);
                if (!userId) {
                    console.error("[Stripe webhook] checkout.session.completed without user_id");
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

                await db.prepare(`
                    INSERT INTO subscriptions (
                        user_id, stripe_customer_id, stripe_subscription_id, status,
                        plan, price_id, current_period_end, trial_end,
                        cancel_at_period_end, nif, name, email, phone,
                        address, city, zip, country, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(user_id) DO UPDATE SET
                        stripe_customer_id = excluded.stripe_customer_id,
                        stripe_subscription_id = excluded.stripe_subscription_id,
                        status = excluded.status,
                        plan = excluded.plan,
                        price_id = excluded.price_id,
                        current_period_end = excluded.current_period_end,
                        trial_end = excluded.trial_end,
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
                await upsertSubscriptionFromStripeSub(db, userId, sub);
                await db.prepare(
                    "INSERT OR IGNORE INTO billing_events (id, user_id, type, stripe_object_id, raw_json) VALUES (?, ?, ?, ?, ?)"
                ).bind(event.id, userId, event.type, sub.id, JSON.stringify(sub)).run();
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

                const pi = (invoice as any).payment_intent;
                const piId = typeof pi === "string" ? pi : pi?.id;

                // Insert billing_event first (idempotent)
                await db.prepare(`
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

                // For paid invoices: try IX matching. Errors here MUST NOT bubble (cron retries).
                if (event.type === "invoice.paid" && piId) {
                    try {
                        const sub: any = await db.prepare("SELECT nif, name, email, address FROM subscriptions WHERE user_id = ?").bind(userId).first();
                        const match = await matchStripeChargeToIX({
                            payment_intent_id: piId,
                            candidate: {
                                nif: sub?.nif || invoice.customer_tax_ids?.[0]?.value || null,
                                email: sub?.email || invoice.customer_email || null,
                                name: sub?.name || invoice.customer_name || null,
                                address: sub?.address || null,
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
