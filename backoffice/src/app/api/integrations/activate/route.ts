import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

const WORKER_URL = "https://shopify-invoicexpress-worker.pedrotovarporto.workers.dev";

export async function POST(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return new NextResponse("Unauthorized", { status: 401 });

    const { env } = getRequestContext();
    const db = (env as any).DB;

    if (!db) {
        console.error("D1 Binding 'DB' not found in env");
        return NextResponse.json({ error: "Database binding missing" }, { status: 500 });
    }

    try {
        const integration: any = await db
            .prepare("SELECT * FROM integrations WHERE user_id = ?")
            .bind(userId)
            .first();

        if (!integration || !integration.shopify_domain || !integration.shopify_token) {
            return NextResponse.json({ error: "Shopify integration not configured" }, { status: 400 });
        }

        const { shopify_domain, shopify_token, shopify_api_version } = integration;
        const apiVersion = shopify_api_version || "2026-01";

        // Register Webhooks in Shopify
        const webhooks = [
            { topic: "orders/paid", address: `${WORKER_URL}/webhooks/shopify/orders-paid` },
            { topic: "refunds/create", address: `${WORKER_URL}/webhooks/shopify/refunds-create` }
        ];

        const results = [];

        for (const hook of webhooks) {
            const response = await fetch(`https://${shopify_domain}/admin/api/${apiVersion}/webhooks.json`, {
                method: "POST",
                headers: {
                    "X-Shopify-Access-Token": shopify_token,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    webhook: {
                        topic: hook.topic,
                        address: hook.address,
                        format: "json"
                    }
                })
            });

            const data: any = await response.json();
            results.push({ topic: hook.topic, status: response.status, data });
        }

        return NextResponse.json({ success: true, results });
    } catch (error) {
        console.error("Activation Error:", error);
        return NextResponse.json({ error: "Failed to activate webhooks" }, { status: 500 });
    }
}
