import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, getImpersonationId } from "@/lib/admin";

export const runtime = "edge";

export async function POST(request: NextRequest) {
    try {
        const { userId } = await auth();
        let targetUserId = userId;

        if (!userId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const isSuperAdmin = await isAdmin(userId);
        if (isSuperAdmin) {
            const impId = await getImpersonationId(request);
            if (impId) targetUserId = impId;
        }

        const body = await request.json() as { type: "shopify" | "ix" };
        const { env } = getRequestContext();
        const db = (env as any).DB;

        // Fetch current config
        const config: any = await db.prepare("SELECT * FROM integrations WHERE user_id = ?").bind(targetUserId).first();
        if (!config) return NextResponse.json({ error: "No integration found" }, { status: 404 });

        let isValid = false;
        let errorMessage = "";

        if (body.type === "shopify") {
            let domain = config.shopify_domain || "";
            const token = config.shopify_token;
            const version = config.shopify_api_version || "2026-01";

            domain = domain.replace(/^https?:\/\//, "").replace(/\/$/, "");

            if (!domain || !token) return NextResponse.json({ error: "Missing Shopify credentials" }, { status: 400 });

            try {
                // Try to get shop info to validate token and domain
                const url = `https://${domain}/admin/api/${version}/shop.json`;
                const res = await fetch(url, {
                    headers: {
                        "X-Shopify-Access-Token": token,
                        "Accept": "application/json"
                    }
                });

                if (res.status === 200) {
                    isValid = true;
                } else {
                    const data = await res.json() as any;
                    errorMessage = data.errors || `Error ${res.status}: ${res.statusText}. Please check Token permissions.`;
                }
            } catch (e: any) {
                errorMessage = `Network failure: ${e.message}`;
                isValid = false;
            }

            await db.prepare("UPDATE integrations SET shopify_authorized = ?, shopify_error = ? WHERE user_id = ?")
                .bind(isValid ? 1 : 0, errorMessage || null, targetUserId).run();

        } else if (body.type === "ix") {
            const account = config.ix_account_name;
            const apiKey = config.ix_api_key;
            const environment = config.ix_environment || "production";

            if (!account || !apiKey) return NextResponse.json({ error: "Missing IX credentials" }, { status: 400 });

            const suffix = environment === "macewindu" ? ".macewindu.invoicexpress.com" : ".invoicexpress.com";
            const domain = account.includes('.') ? account : `${account}${suffix}`;

            try {
                // Check if account is valid by listing clients (lightweight check)
                const res = await fetch(`https://${domain}/clients.json?per_page=1&api_key=${apiKey}`, {
                    headers: { "Accept": "application/json" }
                });

                if (res.status === 200) {
                    isValid = true;
                } else {
                    const text = await res.text();
                    try {
                        const data = JSON.parse(text);
                        errorMessage = data.errors || `Error ${res.status}. Check API Key and Account (Slug).`;
                    } catch {
                        errorMessage = `Error ${res.status}. Check Slug [${account}] and API Key.`;
                    }
                }
            } catch (e: any) {
                errorMessage = `Network failure: ${e.message}`;
                isValid = false;
            }

            await db.prepare("UPDATE integrations SET ix_authorized = ?, ix_error = ? WHERE user_id = ?")
                .bind(isValid ? 1 : 0, errorMessage || null, targetUserId).run();
        }

        return NextResponse.json({ success: true, isValid, error: errorMessage });

    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
