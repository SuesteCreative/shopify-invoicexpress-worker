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

        if (body.type === "shopify") {
            let domain = config.shopify_domain || "";
            const token = config.shopify_token;
            const version = config.shopify_api_version || "2026-01";

            // Clean domain (remove https://, trailing slashes, etc)
            domain = domain.replace(/^https?:\/\//, "").replace(/\/$/, "");

            if (!domain || !token) return NextResponse.json({ error: "Missing Shopify credentials" }, { status: 400 });

            try {
                const url = `https://${domain}/admin/api/${version}/shop.json`;
                const res = await fetch(url, {
                    headers: { "X-Shopify-Access-Token": token }
                });
                isValid = res.status === 200;
                if (!isValid) {
                    console.error(`[Validate] Shopify fail (${res.status}): ${await res.text()}`);
                }
            } catch (e: any) {
                console.error(`[Validate] Shopify network error: ${e.message}`);
                isValid = false;
            }

            await db.prepare("UPDATE integrations SET shopify_authorized = ? WHERE user_id = ?")
                .bind(isValid ? 1 : 0, targetUserId).run();

        } else if (body.type === "ix") {
            const account = config.ix_account_name;
            const apiKey = config.ix_api_key;
            const environment = config.ix_environment || "production";

            if (!account || !apiKey) return NextResponse.json({ error: "Missing IX credentials" }, { status: 400 });

            const suffix = environment === "macewindu" ? ".macewindu.invoicexpress.com" : ".invoicexpress.com";
            const domain = account.includes('.') ? account : `${account}${suffix}`;

            try {
                const res = await fetch(`https://${domain}/clients.json?per_page=1&api_key=${apiKey}`, {
                    headers: { "Accept": "application/json" }
                });
                isValid = res.status === 200;
            } catch (e) {
                isValid = false;
            }

            await db.prepare("UPDATE integrations SET ix_authorized = ? WHERE user_id = ?")
                .bind(isValid ? 1 : 0, targetUserId).run();
        }

        return NextResponse.json({ success: true, isValid });

    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
