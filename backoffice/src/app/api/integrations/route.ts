import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

export async function GET(request: NextRequest) {
    try {
        const { userId } = await auth();

        if (!userId) {
            console.warn("API GET: No userId found in auth().");
            return NextResponse.json({
                error: "Unauthorized: Session missing or invalid",
                debug: {
                    hasUserId: !!userId,
                    runtime: "edge"
                }
            }, { status: 401 });
        }

        const { env } = getRequestContext();
        const db = (env as any).DB;

        if (!db) {
            console.error("D1 Binding 'DB' not found in env");
            return NextResponse.json({ error: "Database binding missing" }, { status: 500 });
        }

        const integration = await db
            .prepare("SELECT * FROM integrations WHERE user_id = ?")
            .bind(userId)
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
        if (!userId) {
            return NextResponse.json({ error: "Unauthorized: Session missing or invalid" }, { status: 401 });
        }

        const body: any = await request.json();
        const { env } = getRequestContext();
        const db = (env as any).DB;

        if (!db) {
            console.error("D1 Binding 'DB' not found in env");
            return NextResponse.json({ error: "Database binding missing" }, { status: 500 });
        }

        const { shopify_domain, shopify_token, ix_account_name, ix_api_key, vat_included, auto_finalize } = body;

        // Check if integration exists
        const existing = await db
            .prepare("SELECT id FROM integrations WHERE user_id = ?")
            .bind(userId)
            .first();

        if (existing) {
            await db
                .prepare(`
          UPDATE integrations 
          SET shopify_domain = ?, shopify_token = ?, ix_account_name = ?, ix_api_key = ?, vat_included = ?, auto_finalize = ?, updated_at = CURRENT_TIMESTAMP
          WHERE user_id = ?
        `)
                .bind(
                    shopify_domain || null,
                    shopify_token || null,
                    ix_account_name || null,
                    ix_api_key || null,
                    vat_included !== undefined ? (vat_included ? 1 : 0) : 1,
                    auto_finalize !== undefined ? (auto_finalize ? 1 : 0) : 0,
                    userId
                )
                .run();
        } else {
            const id = crypto.randomUUID();
            await db
                .prepare(`
          INSERT INTO integrations (id, user_id, shopify_domain, shopify_token, ix_account_name, ix_api_key, vat_included, auto_finalize)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
                .bind(
                    id,
                    userId,
                    shopify_domain || null,
                    shopify_token || null,
                    ix_account_name || null,
                    ix_api_key || null,
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
