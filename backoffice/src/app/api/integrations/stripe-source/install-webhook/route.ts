import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, getImpersonationId } from "@/lib/admin";
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
];

async function resolveTargetUser(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return { error: "Unauthorized", status: 401 as const };
    let targetUserId = userId;
    if (await isAdmin(userId)) {
        const impersonationId = await getImpersonationId(request);
        if (impersonationId) targetUserId = impersonationId;
    }
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

    const body = await request.json().catch(() => ({})) as { restricted_key?: string; connect?: boolean };
    const restrictedKey = (body.restricted_key || "").trim();
    if (!restrictedKey) return NextResponse.json({ error: "Missing restricted_key" }, { status: 400 });
    // Stripe Connect direct charges: events fire on the connected account and
    // are only delivered to a Connect endpoint (connect=true). A plain account
    // endpoint never receives them. https://docs.stripe.com/connect/webhooks
    const isConnect = body.connect === true;

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
        return NextResponse.json({ ok: true, already_installed: true, webhook_endpoint_id: cfg.webhook_endpoint_id });
    }

    const workerUrl = (process.env.WORKER_URL || RIOKO_CONFIG.workerUrl).replace(/\/$/, "");
    const webhookUrl = `${workerUrl}/webhooks/stripe`;

    // Connect: ONE endpoint serves every connected account on a platform. If each
    // connected-account connection created its own endpoint, Stripe would fan each
    // event out to all of them — each signed with a different secret — and the
    // worker (which routes by event.account to a single row) would reject every
    // delivery except the one matching that row's secret. So for Connect we reuse
    // the platform's existing endpoint id + secret across all connections.
    let platformAccountId: string | undefined;
    let endpointId: string | undefined;
    let signingSecret: string | undefined;
    let reused = false;

    if (isConnect) {
        platformAccountId = await fetchPlatformAccountId(restrictedKey);
        if (platformAccountId) {
            const existing: any = await db
                .prepare(
                    `SELECT source_config_json FROM connections
                     WHERE source_kind = 'stripe'
                       AND json_extract(source_config_json, '$.platform_account_id') = ?
                       AND json_extract(source_config_json, '$.webhook_secret') IS NOT NULL
                       AND json_extract(source_config_json, '$.webhook_endpoint_id') IS NOT NULL
                     LIMIT 1`
                )
                .bind(platformAccountId)
                .first();
            if (existing?.source_config_json) {
                const ecfg = JSON.parse(existing.source_config_json);
                if (ecfg.webhook_secret && ecfg.webhook_endpoint_id) {
                    endpointId = ecfg.webhook_endpoint_id;
                    signingSecret = ecfg.webhook_secret;
                    reused = true;
                }
            }
        }
    }

    if (!reused) {
        // Stripe API form-encodes parameters; arrays use bracketed indices.
        const form = new URLSearchParams();
        form.set("url", webhookUrl);
        form.set("description", `Rioko 2.0 — auto-installed${isConnect ? " (Connect)" : ""}`);
        ENABLED_EVENTS.forEach((evt, i) => form.set(`enabled_events[${i}]`, evt));
        // connect=true makes Stripe deliver events from all connected accounts to
        // this single platform endpoint, each carrying a top-level `account` field.
        if (isConnect) form.set("connect", "true");

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

        endpointId = stripeBody.id as string | undefined;
        signingSecret = stripeBody.secret as string | undefined;
        if (!endpointId || !signingSecret) {
            return NextResponse.json({ error: "Stripe response missing id/secret", raw: stripeBody }, { status: 502 });
        }
    }

    const newCfg = {
        ...cfg,
        restricted_key: cfg.restricted_key || restrictedKey,
        webhook_secret: signingSecret,
        webhook_endpoint_id: endpointId,
        is_connect: isConnect,
        ...(platformAccountId ? { platform_account_id: platformAccountId } : {}),
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
        reused_platform_endpoint: reused,
    });
}

/**
 * The connected-account endpoint reuse needs a stable platform identity. A
 * restricted key's GET /account returns the account that owns the key (the
 * platform). Returns undefined on any failure — caller falls back to creating a
 * fresh endpoint rather than blocking install.
 */
async function fetchPlatformAccountId(restrictedKey: string): Promise<string | undefined> {
    try {
        const res = await fetch("https://api.stripe.com/v1/account", {
            headers: {
                "Authorization": `Bearer ${restrictedKey}`,
                "Stripe-Version": "2024-12-18.acacia",
            },
        });
        if (!res.ok) return undefined;
        const body: any = await res.json();
        return typeof body?.id === "string" ? body.id : undefined;
    } catch {
        return undefined;
    }
}
