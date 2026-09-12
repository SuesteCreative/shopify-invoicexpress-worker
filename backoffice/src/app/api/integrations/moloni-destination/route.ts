import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/account";
import { probeConnectionTaxInBackground } from "@/lib/stripe-connect";
import { grantReferralGrace } from "@/lib/referral-grace";

export const runtime = "edge";

/**
 * Moloni destination connection management.
 *
 * Writes Moloni OAuth credentials + company/document_set ids to
 * `connections.destination_config_json` for a given (user_id, source_kind) pair.
 * The worker's `MoloniDestination` adapter reads these via `ctx.destinationConfig`.
 *
 * For now only Stripe-source connections route through the adapter pipeline;
 * Shopify-source still uses the legacy IX-direct handlers until the migration
 * tracked in implementation.md lands. Calls with `source_kind=shopify` are
 * accepted (row is written) but a warning is returned so the UI can surface it.
 */
async function resolveTargetUser(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return { error: "Unauthorized", status: 401 as const };

    let targetUserId = await resolveAccountUser(request, userId);
    return { userId, targetUserId };
}

type MoloniBody = {
    source_kind?: "stripe" | "stripe_connect" | "shopify" | "lodgify";
    moloni_client_id?: string;
    moloni_client_secret?: string;
    moloni_username?: string;
    moloni_password?: string;
    moloni_company_id?: number | string;
    moloni_company_name?: string;
    moloni_document_set_id?: number | string;
    moloni_document_set_name?: string;
    moloni_document_type?: "invoice" | "invoice_receipt";
    moloni_environment?: "production" | "sandbox";
    vat_included?: boolean;
    auto_finalize?: boolean;
    send_email?: boolean;
    moloni_partial_invoicing?: boolean;
    exemption_reason?: string;
    default_vat_rate?: number | string | null;
    // The tax registrations the merchant declares. Absent keeps whatever is
    // stored — see the write below, which never flips one on.
    oss_engine?: boolean;
    pt_regional_rates?: boolean;
    b2b_reverse_charge_pipeline?: boolean;
    oss_export_exemption_code?: string;
    status?: "draft" | "active" | "paused" | "error";
};

function redactConfig(cfg: Record<string, unknown>) {
    return {
        moloni_client_id: cfg.moloni_client_id ?? null,
        has_client_secret: !!cfg.moloni_client_secret,
        moloni_username: cfg.moloni_username ?? null,
        has_password: !!cfg.moloni_password,
        moloni_company_id: cfg.moloni_company_id ?? null,
        moloni_company_name: cfg.moloni_company_name ?? null,
        moloni_document_set_id: cfg.moloni_document_set_id ?? null,
        moloni_document_set_name: cfg.moloni_document_set_name ?? null,
        moloni_document_type: cfg.moloni_document_type ?? "invoice",
        // Whether the OAuth round trip landed. The token itself never leaves the
        // server; this is the only thing a wizard needs to know.
        moloni_authorized: !!cfg.moloni_refresh_token,
        moloni_oauth_error: cfg.moloni_oauth_error ?? null,
        moloni_environment: cfg.moloni_environment ?? "production",
        vat_included: cfg.vat_included !== false,
        auto_finalize: cfg.auto_finalize === true,
        send_email: cfg.send_email === true,
        moloni_partial_invoicing: cfg.moloni_partial_invoicing === true,
        exemption_reason: cfg.exemption_reason ?? "M01",
        default_vat_rate: cfg.default_vat_rate ?? null,
        // The registrations keep their THIRD state. Every field above collapses
        // absent into a value — `vat_included: cfg.vat_included !== false` reads
        // an unset key as true — and doing that here would be the bug: the wizard
        // would render `false`, save it back, and materialise a decision the
        // merchant never made on a field that changes the VAT of every document.
        // `undefined` is dropped by JSON.stringify, so absent stays absent.
        oss_engine: typeof cfg.oss_engine === "boolean" ? cfg.oss_engine : undefined,
        pt_regional_rates: typeof cfg.pt_regional_rates === "boolean" ? cfg.pt_regional_rates : undefined,
        b2b_reverse_charge_pipeline: typeof cfg.b2b_reverse_charge_pipeline === "boolean" ? cfg.b2b_reverse_charge_pipeline : undefined,
        oss_export_exemption_code: typeof cfg.oss_export_exemption_code === "string" ? cfg.oss_export_exemption_code : undefined,
    };
}

/**
 * Which connection a Moloni settings write belongs to.
 *
 * Unknown values still collapse to "stripe", which is the behaviour every caller
 * has relied on since this route was written. The only thing that changed is
 * that "stripe_connect" is now a value of its own — without it, the new wizard's
 * settings would be written straight onto an existing Stripe→Moloni customer's
 * live connection, which is the one row this project must not touch.
 */
function normalizeSourceKind(raw: string | null | undefined): string {
    if (raw === "shopify") return "shopify";
    if (raw === "lodgify") return "lodgify";
    if (raw === "stripe_connect") return "stripe_connect";
    return "stripe";
}

export async function GET(request: NextRequest) {
    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const rawSrc = new URL(request.url).searchParams.get("source_kind") ?? "stripe";
    const sourceKind = normalizeSourceKind(rawSrc);

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    const row: any = await db
        .prepare(
            `SELECT id, status, destination_config_json, created_at, updated_at
             FROM connections WHERE user_id = ? AND source_kind = ? AND destination_kind = 'moloni' LIMIT 1`
        )
        .bind(authResult.targetUserId, sourceKind)
        .first();

    if (!row) return NextResponse.json({ connection: null });

    const cfg = row.destination_config_json ? JSON.parse(row.destination_config_json) : {};
    return NextResponse.json({
        connection: {
            id: row.id,
            status: row.status,
            source_kind: sourceKind,
            destination_config: redactConfig(cfg),
            created_at: row.created_at,
            updated_at: row.updated_at,
        },
    });
}

export async function POST(request: NextRequest) {
    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const body = await request.json() as MoloniBody;

    // lodgify must stay "lodgify" so the Lodgify webhook handler finds the
    // destination config in the same row as the source config. All other
    // non-shopify sources collapse to "stripe".
    const sourceKind = normalizeSourceKind(body.source_kind);
    // Resolved AFTER the existing row is read (below), because the default for a
    // connection that already exists is the status it already has. Defaulting to
    // "draft" took a live connection off the air every time someone saved a
    // single toggle from the wizard — the poll only looks at active ones.
    let status: "draft" | "active" | "paused" | "error" =
        ["draft", "active", "paused", "error"].includes(body.status || "")
            ? (body.status as "draft" | "active" | "paused" | "error")
            : "draft";

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    // Preserve existing credentials when body omits them (lets user save invoice
    // settings or partial drafts without re-pasting secrets).
    const existing: any = await db.prepare(
        `SELECT destination_config_json, status FROM connections
         WHERE user_id = ? AND source_kind = ? AND destination_kind = 'moloni' LIMIT 1`
    ).bind(authResult.targetUserId, sourceKind).first();
    const previousCfg = existing?.destination_config_json ? JSON.parse(existing.destination_config_json) : {};
    if (!["draft", "active", "paused", "error"].includes(body.status || "") && existing?.status) {
        status = existing.status;
    }

    const merged = {
        moloni_client_id: body.moloni_client_id ?? previousCfg.moloni_client_id,
        moloni_client_secret: body.moloni_client_secret ?? previousCfg.moloni_client_secret,
        moloni_username: body.moloni_username ?? previousCfg.moloni_username,
        moloni_password: body.moloni_password ?? previousCfg.moloni_password,
        moloni_company_id: body.moloni_company_id ?? previousCfg.moloni_company_id,
        moloni_company_name: body.moloni_company_name ?? previousCfg.moloni_company_name,
        moloni_document_set_id: body.moloni_document_set_id ?? previousCfg.moloni_document_set_id,
        moloni_document_set_name: body.moloni_document_set_name ?? previousCfg.moloni_document_set_name,
        moloni_document_type: body.moloni_document_type ?? previousCfg.moloni_document_type,
        moloni_environment: body.moloni_environment ?? previousCfg.moloni_environment,
    };

    // Require full credentials for active status; drafts allow partial save.
    // company_id + document_set_id are optional when names are present — the
    // Worker queue consumer resolves names → IDs lazily on first invoice.
    if (status === "active") {
        // The four-field check below is unchanged for every connection that
        // authenticates with a username and password — which is all of them
        // except the Stripe Connect ones, and they must keep failing activation
        // if a credential is missing.
        //
        // An OAuth connection has no username and no password. Not missing:
        // never asked for. Demanding them is what blocked "Marcar como activo"
        // on a wizard that had already authorised Moloni successfully. What it
        // must prove instead is that the merchant completed the consent screen,
        // and the refresh token is that proof.
        const isOAuth = previousCfg.moloni_auth_mode === "oauth" || !!previousCfg.moloni_refresh_token;

        const credFields: Array<keyof typeof merged> = isOAuth
            ? ["moloni_client_id", "moloni_client_secret"]
            : ["moloni_client_id", "moloni_client_secret", "moloni_username", "moloni_password"];
        for (const field of credFields) {
            if (merged[field] === undefined || merged[field] === "" || merged[field] === null) {
                return NextResponse.json({ error: `Missing ${field}` }, { status: 400 });
            }
        }
        if (isOAuth && !previousCfg.moloni_refresh_token) {
            return NextResponse.json(
                { error: "O Moloni ainda não foi autorizado. Volte ao passo do Moloni e carregue em autorizar." },
                { status: 400 },
            );
        }
        // Company is required (id or name). The document set is OPTIONAL: when
        // omitted, the Worker uses the account's default série (active_by_default).
        const hasCompany = merged.moloni_company_id || merged.moloni_company_name;
        if (!hasCompany) {
            return NextResponse.json({ error: "Missing company — provide the company name or ID" }, { status: 400 });
        }
    }

    const env_ = (merged.moloni_environment ?? body.moloni_environment) === "sandbox" ? "sandbox" : "production";

    // The wizard's own fields, and ONLY those: this object is a merge patch, not
    // a replacement. Everything already stored and not named here survives
    // untouched, which is what a re-save must do — on 03/09/2026 a merchant asked
    // for auto_finalize to be turned on, and saving that one toggle dropped their
    // OTA invoicing rule, payment method, article category, maturity terms and
    // extras VAT rate, and left the connection in draft.
    //
    // It used to spread `previousCfg` in here and write the result whole. That
    // fixed the erasure but left a narrower hole: a Moloni token rotation landing
    // between the SELECT above and the write below was overwritten with the pair
    // this request had read, and the connection died an hour later with nothing
    // in the logs. Reading a blob to write it back always races; naming only what
    // changed does not.
    const destinationConfig: Record<string, unknown> = {
        moloni_client_id: merged.moloni_client_id ? String(merged.moloni_client_id) : undefined,
        moloni_client_secret: merged.moloni_client_secret ? String(merged.moloni_client_secret) : undefined,
        moloni_username: merged.moloni_username ? String(merged.moloni_username) : undefined,
        moloni_password: merged.moloni_password ? String(merged.moloni_password) : undefined,
        moloni_company_id: merged.moloni_company_id !== undefined && merged.moloni_company_id !== null && merged.moloni_company_id !== "" ? Number(merged.moloni_company_id) : undefined,
        moloni_company_name: merged.moloni_company_name ? String(merged.moloni_company_name) : undefined,
        moloni_document_set_id: merged.moloni_document_set_id !== undefined && merged.moloni_document_set_id !== null && merged.moloni_document_set_id !== "" ? Number(merged.moloni_document_set_id) : undefined,
        moloni_document_set_name: merged.moloni_document_set_name ? String(merged.moloni_document_set_name) : undefined,
        moloni_document_type: merged.moloni_document_type === "invoice_receipt" ? "invoice_receipt" : "invoice",
        moloni_environment: env_,
        vat_included: body.vat_included !== undefined ? body.vat_included : (previousCfg.vat_included !== false),
        auto_finalize: body.auto_finalize !== undefined ? body.auto_finalize === true : (previousCfg.auto_finalize === true),
        // Email the finalized document to the buyer. Opt-in: absent ⇒ keep
        // whatever was stored, never flip it on, because turning it on starts
        // mailing real customers. The worker projects this over ix_send_email.
        send_email: body.send_email !== undefined ? body.send_email === true : (previousCfg.send_email === true),
        // Partial (instalment) invoicing — self-serve opt-in. Consumed by the
        // worker's Lodgify poll (pollLodgifyBookings). undefined ⇒ false.
        moloni_partial_invoicing: body.moloni_partial_invoicing !== undefined
            ? body.moloni_partial_invoicing === true
            : (previousCfg.moloni_partial_invoicing === true),
        // Preserve fields the UI never round-trips but the worker relies on, so a
        // settings re-save from the wizard never erases them. moloni_default_tax_id
        // pins a specific Moloni tax rule (e.g. Overbuilding's 6% = 2297419); losing
        // it would drop line VAT resolution back to the rate-matcher.
        moloni_default_tax_id: previousCfg.moloni_default_tax_id,
        exemption_reason: typeof body.exemption_reason === "string" && body.exemption_reason.trim()
            ? body.exemption_reason.trim()
            : (previousCfg.exemption_reason ?? "M01"),
        // The tax REGISTRATIONS. Same discipline as send_email above: absent
        // keeps whatever is stored and NEVER flips one on, because turning one on
        // changes the VAT on every future document and, through the nightly heal,
        // on the last 30 days. A merchant who never opens that card keeps being
        // invoiced exactly as they are today.
        oss_engine: body.oss_engine !== undefined
            ? body.oss_engine === true
            : previousCfg.oss_engine,
        pt_regional_rates: body.pt_regional_rates !== undefined
            ? body.pt_regional_rates === true
            : previousCfg.pt_regional_rates,
        b2b_reverse_charge_pipeline: body.b2b_reverse_charge_pipeline !== undefined
            ? body.b2b_reverse_charge_pipeline === true
            : previousCfg.b2b_reverse_charge_pipeline,
        oss_export_exemption_code: typeof body.oss_export_exemption_code === "string"
            ? (body.oss_export_exemption_code.trim() || undefined)
            : previousCfg.oss_export_exemption_code,
        // Fallback VAT rate applied when the payment source carries no tax (e.g.
        // Stripe PaymentIntents). "" / null clears it → exempt. Undefined keeps prior.
        default_vat_rate: body.default_vat_rate === "" || body.default_vat_rate === null
            ? undefined
            : (body.default_vat_rate !== undefined && Number.isFinite(Number(body.default_vat_rate))
                ? Number(body.default_vat_rate)
                : previousCfg.default_vat_rate),
    };

    // In a merge patch, an absent key means "leave it alone" and a null means
    // "delete it" — and JSON.stringify drops `undefined` for us, so every field
    // above that resolves to undefined is left alone rather than erased.
    //
    // Clearing therefore has to be said out loud: "" / null on default_vat_rate
    // means exempt, and a null is how that reaches json_patch.
    if (body.default_vat_rate === "" || body.default_vat_rate === null) {
        destinationConfig.default_vat_rate = null;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.prepare(
        `INSERT INTO connections
          (id, user_id, source_kind, destination_kind, destination_config_json, status, created_at, updated_at)
         VALUES (?, ?, ?, 'moloni', ?, ?, ?, ?)
         ON CONFLICT(user_id, source_kind, destination_kind) DO UPDATE SET
           destination_config_json = json_patch(
             CASE WHEN json_valid(connections.destination_config_json)
                  THEN connections.destination_config_json ELSE '{}' END,
             excluded.destination_config_json),
           status = excluded.status,
           updated_at = excluded.updated_at`
    ).bind(id, authResult.targetUserId, sourceKind, JSON.stringify(destinationConfig), status, now, now).run();

    // A referred account's free month is keyed to a connection (0044) and at
    // claim time there was none. One exists now, so put it here rather than
    // leave the gate refusing the first order of a merchant who was promised
    // thirty free days. A no-op for everyone who was never referred.
    await grantReferralGrace(db, authResult.targetUserId).catch(() => { /* never block a save */ });

    // Going live is the first moment we can ask Stripe what this merchant's
    // payments actually look like, and the answer decides whether their VAT is
    // read from the source or left at 0.
    if (sourceKind === "stripe_connect" && status === "active") {
        probeConnectionTaxInBackground(authResult.targetUserId, "moloni");
    }

    const response: Record<string, unknown> = { ok: true };
    if (sourceKind === "shopify") {
        response.warning = "Shopify-source webhooks still use the legacy IX-direct handlers until the adapter pipeline migration lands. Moloni destination will only fire for Stripe-source connections.";
    }
    return NextResponse.json(response);
}

export async function DELETE(request: NextRequest) {
    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const rawSrc2 = new URL(request.url).searchParams.get("source_kind") ?? "stripe";
    const sourceKind = normalizeSourceKind(rawSrc2);

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    await db.prepare(
        `DELETE FROM connections WHERE user_id = ? AND source_kind = ? AND destination_kind = 'moloni'`
    ).bind(authResult.targetUserId, sourceKind).run();

    return NextResponse.json({ ok: true });
}
