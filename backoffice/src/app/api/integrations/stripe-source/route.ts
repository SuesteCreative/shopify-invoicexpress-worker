import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/account";

export const runtime = "edge";

/**
 * Phase 3 — Stripe-as-a-source connection management. Hidden behind feature flag:
 *   NEXT_PUBLIC_STRIPE_SOURCE_ENABLED=1 in the backoffice env
 * The worker has its own gate via STRIPE_SOURCE_ENABLED.
 *
 * Writes a `connections` row with source_kind='stripe' (drafts a connection
 * pointing at IX as destination by default). Does NOT touch the legacy
 * `integrations` row — Stripe-source data lives only in `connections`.
 */
async function resolveTargetUser(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return { error: "Unauthorized", status: 401 as const };

    let targetUserId = await resolveAccountUser(request, userId);
    return { userId, targetUserId };
}

/**
 * What the connection may state instead of the shared `integrations` row.
 *
 * An account with both a Shopify shop and a Stripe account invoicing into the
 * same InvoiceXpress account needs two different series, and the legacy row
 * holds one — so whichever wizard was saved last used to win. These three live
 * on the connection; the worker reads them through `projectConnectionBehaviour`
 * and falls back to the legacy row for anything left blank.
 */
const FISCAL_KEYS = ["ix_sequence_name", "ix_exemption_reason", "ix_document_type"] as const;

function isEnabled() {
    return process.env.NEXT_PUBLIC_STRIPE_SOURCE_ENABLED === "1"
        || process.env.STRIPE_SOURCE_ENABLED === "1";
}

export async function GET(request: NextRequest) {
    if (!isEnabled()) return NextResponse.json({ error: "Disabled" }, { status: 404 });

    const auth = await resolveTargetUser(request);
    if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    const row: any = await db
        .prepare("SELECT id, status, source_config_json, destination_config_json, destination_kind, created_at, updated_at FROM connections WHERE user_id = ? AND source_kind = 'stripe' LIMIT 1")
        .bind(auth.targetUserId)
        .first();

    if (!row) return NextResponse.json({ connection: null });

    // Redact webhook_secret + restricted key from response — only return non-secret fields.
    const cfg = row.source_config_json ? JSON.parse(row.source_config_json) : {};
    const safeCfg = {
        stripe_account_id: cfg.stripe_account_id ?? null,
        has_webhook_secret: !!cfg.webhook_secret,
        has_restricted_key: !!cfg.restricted_key,
    };
    // The fiscal identity this connection states for itself. Absent keys mean
    // "inherit the account's legacy row", which is what the worker does with them.
    const dCfg = row.destination_config_json ? JSON.parse(row.destination_config_json) : {};
    const fiscal = Object.fromEntries(
        FISCAL_KEYS.filter((k) => typeof dCfg[k] === "string").map((k) => [k, dCfg[k]]),
    );

    return NextResponse.json({
        connection: {
            id: row.id, status: row.status, destination_kind: row.destination_kind,
            source_config: safeCfg, fiscal, created_at: row.created_at, updated_at: row.updated_at,
        }
    });
}

export async function POST(request: NextRequest) {
    if (!isEnabled()) return NextResponse.json({ error: "Disabled" }, { status: 404 });

    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const body = await request.json() as {
        stripe_account_id?: string;
        webhook_secret?: string;
        restricted_key?: string;
        destination_kind?: string;
        status?: string;
        fiscal?: Record<string, unknown>;
    };

    if (!body.stripe_account_id || typeof body.stripe_account_id !== "string") {
        return NextResponse.json({ error: "Missing stripe_account_id" }, { status: 400 });
    }
    const destinationKind = body.destination_kind === "moloni" ? "moloni" : "invoicexpress";
    // NULL means "whatever the row already says". Every caller here is partial,
    // and the invoice-settings step posts no status at all — defaulting to
    // "draft" on the update would have deactivated a live connection the moment
    // the merchant re-saved their series.
    const status = ["draft", "active", "paused", "error"].includes(body.status || "") ? body.status! : null;

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    // Only ever the fields this request actually carries. The upsert below MERGES
    // this into whatever the row already holds (json_patch) instead of replacing
    // it, because the callers are partial by design: the wizard's activate step
    // posts nothing but `{ status: "active" }`, and install-webhook posts nothing
    // but the webhook pair. A replace let the activate click erase the restricted
    // key and webhook secret saved seconds earlier, leaving an ACTIVE connection
    // with no credentials — no signature to verify against, so every event 404s.
    const sourceConfig: Record<string, any> = { stripe_account_id: body.stripe_account_id };
    if (body.webhook_secret) sourceConfig.webhook_secret = body.webhook_secret;
    if (body.restricted_key) sourceConfig.restricted_key = body.restricted_key;

    // Only the fiscal keys this request carries, so a partial post never erases
    // a sibling. An empty string is meaningful and kept: it clears the override
    // and hands the field back to the account's legacy row.
    const fiscalPatch: Record<string, string> = {};
    for (const key of FISCAL_KEYS) {
        const value = body.fiscal?.[key];
        if (typeof value === "string") fiscalPatch[key] = value.trim();
    }
    const hasFiscal = Object.keys(fiscalPatch).length > 0;

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.prepare(
        `INSERT INTO connections
          (id, user_id, source_kind, destination_kind, source_config_json, destination_config_json, status, created_at, updated_at)
         VALUES (?, ?, 'stripe', ?, ?, ?, COALESCE(?, 'draft'), ?, ?)
         ON CONFLICT(user_id, source_kind, destination_kind) DO UPDATE SET
           source_config_json = json_patch(COALESCE(connections.source_config_json, '{}'), excluded.source_config_json),
           destination_config_json = CASE WHEN ? = 1
             THEN json_patch(COALESCE(connections.destination_config_json, '{}'), excluded.destination_config_json)
             ELSE connections.destination_config_json END,
           status = COALESCE(?, connections.status),
           updated_at = excluded.updated_at`
    ).bind(
        id, authResult.targetUserId, destinationKind, JSON.stringify(sourceConfig),
        hasFiscal ? JSON.stringify(fiscalPatch) : null, status, now, now,
        hasFiscal ? 1 : 0, status,
    ).run();

    return NextResponse.json({ ok: true });
}
