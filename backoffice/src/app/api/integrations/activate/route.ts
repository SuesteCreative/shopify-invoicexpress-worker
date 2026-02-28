import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

const WORKER_URL = "https://shopify-invoicexpress-worker.pedro.workers.dev"; // We might want this to be an env var

interface CloudflareEnv {
    DB: D1Database;
}

export async function POST(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return new NextResponse("Unauthorized", { status: 401 });

    const { env } = getRequestContext<{ env: CloudflareEnv }>();
    const db = env.DB;

    try {
        const integration: any = await db
            .prepare("SELECT * FROM integrations WHERE user_id = ?")
            .bind(userId)
            .first();

        if (!integration || !integration.shopify_domain || !integration.shopify_token) {
            return NextResponse.json({ error: "Shopify integration not configured" }, { status: 400 });
        }

        const { shopify_domain, shopify_token } = integration;

        // Register Webhooks in Shopify
        const webhooks = [
            { topic: "orders/paid", address: `${WORKER_URL}/webhooks/shopify/orders-paid` },
            { topic: "refunds/create", address: `${WORKER_URL}/webhooks/shopify/refunds-create` }
        ];

        const results = [];

        for (const hook of webhooks) {
            const response = await fetch(`https://${shopify_domain}/admin/api/2026-01/webhooks.json`, {
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
