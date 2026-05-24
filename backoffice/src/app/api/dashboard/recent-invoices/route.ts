import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, getImpersonationId } from "@/lib/admin";

export const runtime = "edge";

/**
 * Last N invoices processed by the Rioko worker for the current user.
 *
 * Reads from `processed_orders` (one row per (source order → destination doc)).
 * Returns the raw row + an IX URL prebuilt from the user's `ix_account_name`
 * + `ix_environment`. Amount and live IX status are NOT included — that
 * would require N IX API calls per dashboard render. Add only if it becomes
 * worth the latency / quota.
 */
export async function GET(request: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        let targetUserId = userId;
        if (await isAdmin(userId)) {
            const impersonationId = await getImpersonationId(request);
            if (impersonationId) targetUserId = impersonationId;
        }

        const { env } = getRequestContext();
        const db = (env as any).DB;
        if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

        const integration: any = await db
            .prepare("SELECT shopify_domain, ix_account_name, ix_environment FROM integrations WHERE user_id = ?")
            .bind(targetUserId)
            .first();

        if (!integration || !integration.shopify_domain) {
            return NextResponse.json({ invoices: [], ix_account_name: null });
        }

        const rows: any = await db
            .prepare(
                "SELECT id, invoice_id, created_at, source_kind, destination_kind " +
                "FROM processed_orders WHERE shopify_domain = ? " +
                "ORDER BY created_at DESC LIMIT 5"
            )
            .bind(integration.shopify_domain)
            .all();

        const ixHost = integration.ix_environment === "development"
            ? "app.invoicexpress.com"
            : "app.invoicexpress.com"; // same host for both envs; account subdomain differentiates
        const account = integration.ix_account_name;

        const invoices = (rows?.results || []).map((r: any) => ({
            order_id: r.id,
            invoice_id: r.invoice_id,
            created_at: r.created_at,
            source_kind: r.source_kind || "shopify",
            destination_kind: r.destination_kind || "invoicexpress",
            ix_url: account && r.invoice_id
                ? `https://${account}.${ixHost}/invoices/${r.invoice_id}`
                : null,
        }));

        return NextResponse.json({ invoices, ix_account_name: account });
    } catch (error: any) {
        console.error("[/api/dashboard/recent-invoices] D1 Error:", error);
        return NextResponse.json({ error: `Internal Server Error: ${error.message}` }, { status: 500 });
    }
}
