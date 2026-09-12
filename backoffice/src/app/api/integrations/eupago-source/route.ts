import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/account";
import { RIOKO_CONFIG } from "@/lib/config";
import { readConnectionFiscal, fiscalPatchFrom, ixCredentialPatchFrom, ixCredentialsOnConnection, ixAccountNameOnConnection } from "@/lib/connection-fiscal";
import { missingDestinationCredentials } from "@/lib/destination-credentials";

export const runtime = "edge";

const WORKER_BASE = RIOKO_CONFIG.workerUrl.replace(/\/$/, "");

/**
 * EuPago source connection management.
 *
 * Stores the merchant's HMAC secret (shared with EuPago to verify webhook
 * signatures) in `connections.source_config_json`. The webhook URL the merchant
 * configures in the EuPago backoffice is:
 *     POST https://<worker-host>/webhooks/eupago/<user_id>
 *
 * Destination (IX, Moloni, Vendus) is chosen via `destination_kind` on the same
 * row. Defaults to "invoicexpress" if not provided.
 */
async function resolveTargetUser(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return { error: "Unauthorized", status: 401 as const };

    let targetUserId = await resolveAccountUser(request, userId);
    return { userId, targetUserId };
}

function redact(cfg: Record<string, unknown>) {
    return {
        has_hmac_secret: !!cfg.hmac_secret,
        api_key_masked: cfg.api_key ? maskKey(String(cfg.api_key)) : null,
        encrypted: cfg.encrypted === true,
    };
}

function maskKey(s: string): string {
    if (s.length <= 8) return "•".repeat(s.length);
    return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

export async function GET(request: NextRequest) {
    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    const row: any = await db.prepare(
        `SELECT id, status, source_config_json, destination_config_json, destination_kind, created_at, updated_at
         FROM connections WHERE user_id = ? AND source_kind = 'eupago' LIMIT 1`
    ).bind(authResult.targetUserId).first();

    if (!row) return NextResponse.json({ connection: null });

    const cfg = row.source_config_json ? JSON.parse(row.source_config_json) : {};
    return NextResponse.json({
        connection: {
            id: row.id,
            status: row.status,
            destination_kind: row.destination_kind ?? "invoicexpress",
            source_config: redact(cfg),
            // What this connection states about its own documents. The wizard
            // shows these instead of the account's legacy row, because for a
            // non-Shopify source that is what the worker reads.
            fiscal: readConnectionFiscal(row.destination_config_json),
            has_ix_credentials: ixCredentialsOnConnection(row.destination_config_json),
            ix_account_name: ixAccountNameOnConnection(row.destination_config_json),
            created_at: row.created_at,
            updated_at: row.updated_at,
            webhook_url: `${WORKER_BASE}/webhooks/eupago/${authResult.targetUserId}`,
        },
    });
}

export async function POST(request: NextRequest) {
    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const body = await request.json() as {
        hmac_secret?: string;
        api_key?: string;
        encrypted?: boolean;
        destination_kind?: "invoicexpress" | "moloni" | "vendus";
        status?: "draft" | "active" | "paused" | "error";
        /** This connection's own InvoiceXpress credentials. */
        ix_credentials?: Record<string, unknown>;
        fiscal?: Record<string, unknown>;
    };

    const destinationKind = ["invoicexpress", "moloni", "vendus"].includes(body.destination_kind || "")
        ? body.destination_kind!
        : "invoicexpress";

    const status = ["draft", "active", "paused", "error"].includes(body.status || "") ? body.status! : "draft";

    if (status === "active" && (!body.hmac_secret || body.hmac_secret.length < 16)) {
        return NextResponse.json({ error: "hmac_secret is required for active status (min 16 chars)" }, { status: 400 });
    }

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    // The destination half of the same rule.
    if (status === "active") {
        const missing = await missingDestinationCredentials(db, authResult.targetUserId, "eupago", destinationKind);
        if (missing) return NextResponse.json({ error: missing }, { status: 409 });
    }

    // The fiscal identity of the documents this connection issues — series,
    // exemption code, document type, whether prices already include tax.
    //
    // It used to be posted to `/api/integrations`, the account's legacy row,
    // where the worker no longer looks: `projectConnectionBehaviour` refuses to
    // read that row for a non-Shopify source, because it belongs to another
    // integration. Merged (json_patch) rather than replaced, so the settings step
    // never erases what the EuPago step wrote.
    // Fiscal identity plus this connection's own InvoiceXpress credentials.
    const fiscalOnly = fiscalPatchFrom(body.fiscal);
    const credentialPatch = ixCredentialPatchFrom(body.ix_credentials);
    const fiscalPatch = (fiscalOnly || credentialPatch)
        ? { ...(fiscalOnly ?? {}), ...(credentialPatch ?? {}) }
        : null;
    const saveFiscal = async (): Promise<boolean> => {
        if (!fiscalPatch) return true;
        const res = await db.prepare(
            `UPDATE connections
                SET destination_config_json = json_patch(COALESCE(destination_config_json, '{}'), ?),
                    updated_at = ?
              WHERE user_id = ? AND source_kind = 'eupago' AND destination_kind = ?`
        ).bind(JSON.stringify(fiscalPatch), new Date().toISOString(),
            authResult.targetUserId, destinationKind).run();
        return (res.meta?.changes ?? 0) > 0;
    };

    // A settings-only post — the wizard's invoice step — must not fall through
    // to the upsert below: `status` defaults to "draft" there, so saving invoice
    // settings would deactivate a live connection.
    if (fiscalPatch && !body.hmac_secret && !body.api_key && !body.status) {
        if (!(await saveFiscal())) {
            return NextResponse.json({ error: "Connect EuPago before saving invoice settings" }, { status: 409 });
        }
        return NextResponse.json({ ok: true });
    }

    // If hmac_secret is empty in the body, preserve the existing one (allows
    // editing destination_kind/status without re-pasting the secret).
    const existing: any = await db.prepare(
        `SELECT source_config_json FROM connections
         WHERE user_id = ? AND source_kind = 'eupago' AND destination_kind = ? LIMIT 1`
    ).bind(authResult.targetUserId, destinationKind).first();
    const previousCfg = existing?.source_config_json ? JSON.parse(existing.source_config_json) : {};

    const sourceCfg: Record<string, any> = {
        hmac_secret: body.hmac_secret || previousCfg.hmac_secret,
        encrypted: body.encrypted === true,
    };
    if (body.api_key) sourceCfg.api_key = body.api_key;
    else if (previousCfg.api_key) sourceCfg.api_key = previousCfg.api_key;

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.prepare(
        `INSERT INTO connections
          (id, user_id, source_kind, destination_kind, source_config_json, status, created_at, updated_at)
         VALUES (?, ?, 'eupago', ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, source_kind, destination_kind) DO UPDATE SET
           source_config_json = excluded.source_config_json,
           status = excluded.status,
           updated_at = excluded.updated_at`
    ).bind(id, authResult.targetUserId, destinationKind, JSON.stringify(sourceCfg), status, now, now).run();

    await saveFiscal();

    return NextResponse.json({
        ok: true,
        webhook_url: `${WORKER_BASE}/webhooks/eupago/${authResult.targetUserId}`,
    });
}

export async function DELETE(request: NextRequest) {
    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const destinationKind = new URL(request.url).searchParams.get("destination_kind") ?? "invoicexpress";

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    await db.prepare(
        `DELETE FROM connections WHERE user_id = ? AND source_kind = 'eupago' AND destination_kind = ?`
    ).bind(authResult.targetUserId, destinationKind).run();

    return NextResponse.json({ ok: true });
}
