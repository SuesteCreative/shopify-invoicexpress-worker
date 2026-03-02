import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, getImpersonationId, getRole } from "@/lib/admin";

export const runtime = "edge";

export async function GET(request: NextRequest) {
    try {
        const { userId } = await auth();
        let targetUserId = userId;

        if (!userId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        // Admin Impersonation Logic
        const isSuperAdmin = await isAdmin(userId);
        let impersonationId: string | null = null;
        if (isSuperAdmin) {
            impersonationId = await getImpersonationId(request);
            if (impersonationId) {
                targetUserId = impersonationId;
                console.log(`[Superadmin] Impersonating ${targetUserId}`);
            }
        }

        const { env } = getRequestContext();
        const db = (env as any).DB;

        if (!db) {
            console.error("D1 Binding 'DB' not found in env");
            return NextResponse.json({ error: "Database binding missing" }, { status: 500 });
        }

        const integration: any = await db
            .prepare("SELECT * FROM integrations WHERE user_id = ?")
            .bind(targetUserId)
            .first();

        // Also fetch the target user's metadata (correct under impersonation)
        const userRecord: any = await db
            .prepare("SELECT name, role FROM users WHERE id = ?")
            .bind(targetUserId)
            .first();

        const viewerRole = await getRole(userId);

        return NextResponse.json({
            ...(integration || {}),
            _user_name: userRecord?.name || null,
            _user_role: userRecord?.role || "user",
            _viewer_role: viewerRole,
            _is_impersonating: !!impersonationId
        });
    } catch (error: any) {
        console.error("D1 Error:", error);
        return NextResponse.json({ error: `Internal Server Error: ${error.message}` }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    try {
        const { userId } = await auth();
        let targetUserId = userId;

        if (!userId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        // Admin Impersonation Logic
        const isSuperAdmin = await isAdmin(userId);
        if (isSuperAdmin) {
            const impersonationId = await getImpersonationId(request);
            if (impersonationId) {
                targetUserId = impersonationId;
                console.log(`[Superadmin] Saving for impersonated ${targetUserId}`);
            }
        }

        const body: any = await request.json();
        const { env } = getRequestContext();
        const db = (env as any).DB;

        if (!db) {
            console.error("D1 Binding 'DB' not found in env");
            return NextResponse.json({ error: "Database binding missing" }, { status: 500 });
        }

        const { shopify_domain, shopify_token, shopify_webhook_secret, shopify_api_version, ix_account_name, ix_api_key, ix_environment, ix_exemption_reason, vat_included, auto_finalize, shopify_authorized, webhooks_active, ix_document_type, ix_payment_term, ix_sequence_name } = body;

        const clean_shopify_domain = shopify_domain ? shopify_domain.replace(/^https?:\/\//, "").replace(/\/$/, "") : null;

        // Check if integration exists
        const existing: any = await db
            .prepare("SELECT * FROM integrations WHERE user_id = ?")
            .bind(targetUserId)
            .first();

        if (existing) {
            // Preserve existing shopify_authorized and webhooks_active if not explicitly provided or if forced
            let final_shopify_authorized = shopify_authorized !== undefined ? (shopify_authorized ? 1 : 0) : existing.shopify_authorized;
            let final_webhooks_active = webhooks_active !== undefined ? (webhooks_active ? 1 : 0) : existing.webhooks_active;

            // If webhooks_active is being set to 0, but it was admin-forced, keep it as 1
            if (final_webhooks_active === 0 && (existing.webhooks_forced_at || existing.webhooks_active === 1)) {
                // We trust the existing value more if we're just doing a generic 'save' from the dashboard
                final_webhooks_active = existing.webhooks_active;
            }

            await db
                .prepare(`
          UPDATE integrations 
          SET shopify_domain = ?, shopify_token = ?, shopify_webhook_secret = ?, shopify_api_version = ?, ix_account_name = ?, ix_api_key = ?, ix_environment = ?, ix_exemption_reason = ?, vat_included = ?, auto_finalize = ?, shopify_authorized = ?, webhooks_active = ?, ix_document_type = ?, ix_payment_term = ?, ix_sequence_name = ?, updated_at = CURRENT_TIMESTAMP
          WHERE user_id = ?
        `)
                .bind(
                    clean_shopify_domain,
                    shopify_token || null,
                    shopify_webhook_secret || null,
                    shopify_api_version || "2026-01",
                    ix_account_name || null,
                    ix_api_key || null,
                    ix_environment || "production",
                    ix_exemption_reason || "M01",
                    vat_included !== undefined ? (vat_included ? 1 : 0) : 1,
                    auto_finalize !== undefined ? (auto_finalize ? 1 : 0) : 0,
                    final_shopify_authorized,
                    final_webhooks_active,
                    ix_document_type || "invoice_receipt",
                    ix_payment_term !== undefined ? parseInt(String(ix_payment_term)) : 0,
                    ix_sequence_name || null,
                    targetUserId
                )
                .run();
        } else {
            const id = crypto.randomUUID();
            await db
                .prepare(`
          INSERT INTO integrations (id, user_id, shopify_domain, shopify_token, shopify_webhook_secret, shopify_api_version, ix_account_name, ix_api_key, ix_environment, ix_exemption_reason, vat_included, auto_finalize, shopify_authorized, webhooks_active, ix_document_type, ix_payment_term, ix_sequence_name)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
                .bind(
                    id,
                    targetUserId,
                    clean_shopify_domain,
                    shopify_token || null,
                    shopify_webhook_secret || null,
                    shopify_api_version || "2026-01",
                    ix_account_name || null,
                    ix_api_key || null,
                    ix_environment || "production",
                    ix_exemption_reason || "M01",
                    vat_included ? 1 : 0,
                    auto_finalize ? 1 : 0,
                    shopify_authorized ? 1 : 0,
                    webhooks_active ? 1 : 0,
                    ix_document_type || "invoice_receipt",
                    ix_payment_term !== undefined ? parseInt(String(ix_payment_term)) : 0,
                    ix_sequence_name || null
                )
                .run();
        }

        return NextResponse.json({ success: true });
    } catch (error: any) {
        console.error("D1 Error:", error);
        return NextResponse.json({ error: `Failed to save integration: ${error.message}` }, { status: 500 });
    }
}
