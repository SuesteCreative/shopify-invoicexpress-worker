import { kv } from "@vercel/kv";
import { sql } from "@vercel/postgres";

export interface RiokoEnv {
    SHOPIFY_WEBHOOK_SECRET: string;
    SHOPIFY_ACCESS_TOKEN: string;
    SHOPIFY_SHOP_DOMAIN: string;
    SHOPIFY_API_VERSION: string;
    INVOICEXPRESS_ACCOUNT_NAME: string;
    INVOICEXPRESS_API_KEY: string;
    INVOICEXPRESS_ENVIRONMENT?: string;
    INVOICEXPRESS_TAX_INCLUDED?: string;
    INVOICEXPRESS_AUTO_FINALIZE?: string;
    INVOICEXPRESS_DOCUMENT_TYPE?: string;
    POS_MODE?: string;
}

/**
 * Save log to Postgres (Vercel)
 */
export async function saveLog(data: { shopify_domain: string | null; topic: string; payload: any; response: any; status: number }) {
    try {
        await sql`
            INSERT INTO logs (id, shopify_domain, topic, payload, response, status) 
            VALUES (${crypto.randomUUID()}, ${data.shopify_domain}, ${data.topic}, ${JSON.stringify(data.payload)}, ${JSON.stringify(data.response)}, ${data.status})
        `;
    } catch (e) {
        console.error("[Rioko-Vercel] Failed to save log:", e);
    }
}

/**
 * Get dynamic config from Postgres
 */
export async function getConfig(shopifyDomain: string | null): Promise<Partial<RiokoEnv>> {
    if (!shopifyDomain) return {};

    try {
        const { rows } = await sql`SELECT * FROM integrations WHERE shopify_domain = ${shopifyDomain} LIMIT 1`;
        const integration = rows[0];

        if (integration) {
            return {
                SHOPIFY_SHOP_DOMAIN: integration.shopify_domain,
                SHOPIFY_ACCESS_TOKEN: integration.shopify_token,
                SHOPIFY_WEBHOOK_SECRET: integration.shopify_webhook_secret,
                INVOICEXPRESS_ACCOUNT_NAME: integration.ix_account_name,
                INVOICEXPRESS_API_KEY: integration.ix_api_key,
                INVOICEXPRESS_AUTO_FINALIZE: integration.auto_finalize === 1 ? "true" : "false",
                POS_MODE: integration.pos_mode === 1 ? "1" : "0",
            };
        }
    } catch (e) {
        console.error("[Rioko-Vercel] DB Fallback to Env:", e);
    }

    return {};
}

/**
 * Idempotency check with Vercel KV (Redis)
 */
export async function isIdempotent(orderId: number | string): Promise<string | null> {
    const key = `shopify_order:${orderId}`;
    try {
        // 1. Try Postgres first
        const { rows } = await sql`SELECT invoice_id FROM processed_orders WHERE id = ${String(orderId)} LIMIT 1`;
        if (rows[0]) return rows[0].invoice_id || "PROCESSED";
    } catch (e) {}

    // 2. Fallback to Redis (Vercel KV)
    return await kv.get<string>(key);
}

/**
 * Mark as invoiced in both systems
 */
export async function markAsInvoiced(orderId: number | string, invoiceId: string, extraData?: any): Promise<void> {
    const key = `shopify_order:${orderId}`;
    try {
        await sql`INSERT INTO processed_orders (id, invoice_id) VALUES (${String(orderId)}, ${invoiceId}) ON CONFLICT (id) DO NOTHING`;
    } catch (e) {}
    
    await kv.set(key, JSON.stringify({ invoice_id: invoiceId, timestamp: new Date().toISOString(), ...extraData }), {
        ex: 60 * 60 * 24 * 30 // 30 days expiry for Redis
    });
}
