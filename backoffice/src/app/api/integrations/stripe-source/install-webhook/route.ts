import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/account";
import { RIOKO_CONFIG } from "@/lib/config";

export const runtime = "edge";

/**
 * Auto-installs the Stripe webhook endpoint on the user's Stripe account using
 * a restricted key with `webhook_endpoints:write` scope. Captures the returned
 * signing secret (only revealed at creation time) and persists it to the
 * `connections.source_config_json` blob.
 *
 * If a `webhook_endpoint_id` is already stored, the call is a no-op.
 */

const ENABLED_EVENTS = [
    "payment_intent.succeeded",
    "charge.succeeded",
    "charge.refunded",
    // Checkout Session events carry custom_fields + customer_details.tax_ids
    // in the payload, removing the need for a Customer API expand when the
    // buyer used Stripe Checkout.
    "checkout.session.completed",
    // Stripe invoices, including the ones a merchant marks as paid OUTSIDE
    // Stripe ("pay out of band" — a transfer, cash, a booking settled at the
    // counter). Nothing else fires for those: no PaymentIntent, no charge. Card-
    // paid invoices dedup against their PaymentIntent (see stripeStableId), so
    // adding this cannot double-invoice a sale that already had an event.
    "invoice.paid",
];

async function resolveTargetUser(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return { error: "Unauthorized", status: 401 as const };
    let targetUserId = await resolveAccountUser(request, userId);
    return { userId, targetUserId };
}

function isEnabled() {
    return process.env.NEXT_PUBLIC_STRIPE_SOURCE_ENABLED === "1"
        || process.env.STRIPE_SOURCE_ENABLED === "1";
}

export async function POST(request: NextRequest) {
    if (!isEnabled()) return NextResponse.json({ error: "Disabled" }, { status: 404 });

    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const body = await request.json().catch(() => ({})) as { restricted_key?: string };
    const restrictedKey = (body.restricted_key || "").trim();
    if (!restrictedKey) return NextResponse.json({ error: "Missing restricted_key" }, { status: 400 });

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    const row: any = await db
        .prepare("SELECT id, source_config_json FROM connections WHERE user_id = ? AND source_kind = 'stripe' LIMIT 1")
        .bind(authResult.targetUserId)
        .first();

    if (!row) return NextResponse.json({ error: "No Stripe connection found. Save Stripe credentials first." }, { status: 404 });

    const cfg = row.source_config_json ? JSON.parse(row.source_config_json) : {};
    if (cfg.webhook_endpoint_id && cfg.webhook_secret) {
        // Already installed — bring its event list up to date instead of
        // reporting success and changing nothing. An endpoint installed before
        // an event was added to ENABLED_EVENTS never receives that event, and
        // nothing anywhere says so: the merchant's invoices simply do not
        // happen. Re-running the install is how an operator fixes that, so it
        // has to actually do something.
        const sync = new URLSearchParams();
        ENABLED_EVENTS.forEach((evt, i) => sync.set(`enabled_events[${i}]`, evt));
        const syncResp = await fetch(
            `https://api.stripe.com/v1/webhook_endpoints/${encodeURIComponent(cfg.webhook_endpoint_id)}`,
            {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${restrictedKey}`,
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Stripe-Version": "2024-12-18.acacia",
                },
                body: sync.toString(),
            },
        ).catch(() => null);

        // A failed sync is reported, never fatal: the endpoint may have been
        // deleted in Stripe, and the operator needs to be told that rather than
        // handed a 500.
        return NextResponse.json({
            ok: true,
            already_installed: true,
            webhook_endpoint_id: cfg.webhook_endpoint_id,
            enabled_events: ENABLED_EVENTS,
            events_synced: !!syncResp?.ok,
            ...(syncResp?.ok ? {} : { sync_error: `Stripe returned ${syncResp?.status ?? "no response"} updating the endpoint's events` }),
        });
    }

    const workerUrl = (process.env.WORKER_URL || RIOKO_CONFIG.workerUrl).replace(/\/$/, "");
    const webhookUrl = `${workerUrl}/webhooks/stripe`;

    // Stripe API form-encodes parameters; arrays use bracketed indices.
    const form = new URLSearchParams();
    form.set("url", webhookUrl);
    form.set("description", "Rioko 2.0 — auto-installed");
    ENABLED_EVENTS.forEach((evt, i) => form.set(`enabled_events[${i}]`, evt));

    let stripeResp: Response;
    try {
        stripeResp = await fetch("https://api.stripe.com/v1/webhook_endpoints", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${restrictedKey}`,
                "Content-Type": "application/x-www-form-urlencoded",
                "Stripe-Version": "2024-12-18.acacia",
            },
            body: form.toString(),
        });
    } catch (e: any) {
        return NextResponse.json({ error: `Network error calling Stripe: ${e.message}` }, { status: 502 });
    }

    const stripeBody: any = await stripeResp.json().catch(() => ({}));
    if (!stripeResp.ok) {
        const msg = stripeBody?.error?.message || `Stripe returned ${stripeResp.status}`;
        const code = stripeBody?.error?.code || "stripe_error";
        return NextResponse.json({ error: msg, stripe_code: code, stripe_status: stripeResp.status }, { status: 400 });
    }

    const endpointId = stripeBody.id as string | undefined;
    const signingSecret = stripeBody.secret as string | undefined;
    if (!endpointId || !signingSecret) {
        return NextResponse.json({ error: "Stripe response missing id/secret", raw: stripeBody }, { status: 502 });
    }

    const newCfg = {
        ...cfg,
        restricted_key: cfg.restricted_key || restrictedKey,
        webhook_secret: signingSecret,
        webhook_endpoint_id: endpointId,
    };

    const now = new Date().toISOString();
    await db.prepare(
        "UPDATE connections SET source_config_json = ?, updated_at = ? WHERE id = ?"
    ).bind(JSON.stringify(newCfg), now, row.id).run();

    return NextResponse.json({
        ok: true,
        webhook_endpoint_id: endpointId,
        webhook_url: webhookUrl,
        enabled_events: ENABLED_EVENTS,
    });
}
