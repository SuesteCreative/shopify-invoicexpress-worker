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
            if (impersonationId) targetUserId = impersonationId;
        }

        const { env } = getRequestContext();
        const db = (env as any).DB;

        // 1. Get Integration
        const integration: any = await db
            .prepare("SELECT ix_account_name, ix_api_key, ix_environment, shopify_domain, shopify_token FROM integrations WHERE user_id = ?")
            .bind(targetUserId)
            .first();

        if (!integration || !integration.ix_account_name || !integration.ix_api_key) {
            return NextResponse.json({ invoices: [] });
        }

        const account = integration.ix_account_name;
        const apiKey = integration.ix_api_key;
        const environment = integration.ix_environment || "production";
        const baseUrl = environment === "production"
            ? `https://${account}.invoicexpress.com`
            : `https://${account}.${environment}.invoicexpress.com`;

        // 2. Fetch Invoices from IX (Last 20)
        // We fetch both invoice_receipts and invoices
        const fetchDocs = async (type: string) => {
            const res = await fetch(`${baseUrl}/${type}.json?per_page=20&api_key=${apiKey}`, {
                headers: { "Accept": "application/json" }
            });
            if (!res.ok) return [];
            const data = await res.json() as any;
            return data[type] || [];
        };

        const [receipts, invoices, creditNotes] = await Promise.all([
            fetchDocs("invoice_receipts"),
            fetchDocs("invoices"),
            fetchDocs("credit_notes")
        ]);

        // 3. Combine and Sort
        const allDocs = [
            ...receipts.map((d: any) => ({ ...d, type: 'invoice_receipt' })),
            ...invoices.map((d: any) => ({ ...d, type: 'invoice' })),
            ...creditNotes.map((d: any) => ({ ...d, type: 'credit_note' }))
        ].sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());

        // 4. Enrich with Logs (from our DB)
        // We look for logs where response contains the document ID or payload matches the reference order ID
        const logs: any = await db
            .prepare("SELECT id, topic, payload, response, status, created_at FROM logs WHERE shopify_domain = ? ORDER BY created_at DESC LIMIT 100")
            .bind(integration.shopify_domain)
            .all();

        const enrichedInvoices = allDocs.slice(0, 20).map((doc: any) => {
            const orderIdMatch = doc.reference?.match(/#(\d+)/);
            const orderId = orderIdMatch ? orderIdMatch[1] : null;

            // Find logs relevant to this document
            // A log is relevant if its response mentions the doc.id or the orderId
            const docLogs = logs.results.filter((l: any) =>
                (l.response && String(l.response).includes(String(doc.id))) ||
                (l.payload && String(l.payload).includes(String(orderId))) ||
                (l.payload && String(l.payload).includes(String(doc.reference)))
            );

            return {
                id: doc.id,
                type: doc.type,
                number: doc.sequence_number,
                status: doc.status || doc.state,
                date: doc.date,
                total: doc.total,
                reference: doc.reference,
                order_id: orderId,
                logs: docLogs
            };
        });

        return NextResponse.json({
            invoices: enrichedInvoices,
            shop: integration.shopify_domain
        });

    } catch (error: any) {
        console.error("[Invoices API] Error:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
