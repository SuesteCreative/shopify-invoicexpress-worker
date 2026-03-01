import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, getImpersonationId } from "@/lib/admin";

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
        if (isSuperAdmin) {
            const impersonationId = await getImpersonationId(request);
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

        const integration = await db
            .prepare("SELECT * FROM integrations WHERE user_id = ?")
            .bind(targetUserId)
            .first();

        return NextResponse.json(integration || {});
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

        const { shopify_domain, shopify_token, shopify_webhook_secret, shopify_api_version, ix_account_name, ix_api_key, ix_environment, ix_exemption_reason, vat_included, auto_finalize } = body;

        const clean_shopify_domain = shopify_domain ? shopify_domain.replace(/^https?:\/\//, "").replace(/\/$/, "") : null;

        // Check if integration exists
        const existing = await db
            .prepare("SELECT id FROM integrations WHERE user_id = ?")
            .bind(targetUserId)
            .first();

        if (existing) {
            await db
                .prepare(`
          UPDATE integrations 
          SET shopify_domain = ?, shopify_token = ?, shopify_webhook_secret = ?, shopify_api_version = ?, ix_account_name = ?, ix_api_key = ?, ix_environment = ?, ix_exemption_reason = ?, vat_included = ?, auto_finalize = ?, updated_at = CURRENT_TIMESTAMP
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
                    targetUserId
                )
                .run();
        } else {
            const id = crypto.randomUUID();
            await db
                .prepare(`
          INSERT INTO integrations (id, user_id, shopify_domain, shopify_token, shopify_webhook_secret, shopify_api_version, ix_account_name, ix_api_key, ix_environment, ix_exemption_reason, vat_included, auto_finalize)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    auto_finalize ? 1 : 0
                )
                .run();
        }

        return NextResponse.json({ success: true });
    } catch (error: any) {
        console.error("D1 Error:", error);
        return NextResponse.json({ error: `Failed to save integration: ${error.message}` }, { status: 500 });
    }
}
