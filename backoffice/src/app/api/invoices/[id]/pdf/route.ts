import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, getImpersonationId } from "@/lib/admin";

export const runtime = "edge";

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
    try {
        const { userId } = await auth();
        let targetUserId = userId;

        if (!userId) {
            return new Response("Unauthorized", { status: 401 });
        }

        // Admin Impersonation Logic
        const isSuperAdmin = await isAdmin(userId);
        if (isSuperAdmin) {
            const impersonationId = await getImpersonationId(request);
            if (impersonationId) targetUserId = impersonationId;
        }

        const { env } = getRequestContext();
        const db = (env as any).DB;

        const integration: any = await db
            .prepare("SELECT ix_account_name, ix_api_key, ix_environment FROM integrations WHERE user_id = ?")
            .bind(targetUserId)
            .first();

        if (!integration || !integration.ix_account_name || !integration.ix_api_key) {
            return new Response("Integration not found", { status: 404 });
        }

        const account = integration.ix_account_name;
        const apiKey = integration.ix_api_key;
        const environment = integration.ix_environment || "production";
        const subdomain = environment === "production" ? "invoicexpress" : environment;
        const baseUrl = `https://${account}.${subdomain}.com`;

        // We need to know the document type. Default to invoice_receipts, but check query
        const type = new URL(request.url).searchParams.get("type") || "invoice_receipts";
        const docId = params.id;

        const res = await fetch(`${baseUrl}/${type}/${docId}/pdf.json?api_key=${apiKey}`, {
            headers: { "Accept": "application/json" }
        });

        if (!res.ok) {
            const err = await res.text();
            console.error(`[PDF Proxy] IX Error (${res.status}):`, err);
            return new Response(`InvoiceXpress Error: ${res.status}`, { status: res.status });
        }

        const data = await res.json() as any;
        const base64 = data[type.slice(0, -1)]?.pdf; // receipts -> receipt, invoices -> invoice

        if (!base64) {
            return new Response("PDF content not found in IX response", { status: 404 });
        }

        const buffer = Buffer.from(base64, "base64");
        return new Response(buffer, {
            headers: {
                "Content-Type": "application/pdf",
                "Content-Disposition": `inline; filename="invoice-${docId}.pdf"`
            }
        });

    } catch (error: any) {
        console.error("[PDF API] Error:", error);
        return new Response(error.message, { status: 500 });
    }
}
