export interface Env {
    INVOICE_KV: KVNamespace;
    DB: D1Database;
    SHOPIFY_WEBHOOK_SECRET: string;
    SHOPIFY_ACCESS_TOKEN: string;
    SHOPIFY_SHOP_DOMAIN: string;
    SHOPIFY_API_VERSION: string;
    INVOICEXPRESS_ACCOUNT_NAME: string;
    INVOICEXPRESS_API_KEY: string;
    INVOICEXPRESS_ENVIRONMENT: string;
    INVOICEXPRESS_TAX_INCLUDED?: string; // "true" or "false"
    INVOICEXPRESS_AUTO_FINALIZE?: string; // "true" or "false"
}

export async function saveLog(env: Env, data: { shopify_domain: string | null; topic: string; payload: any; response: any; status: number }) {
    try {
        await env.DB.prepare(
            "INSERT INTO logs (id, shopify_domain, topic, payload, response, status) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(
            crypto.randomUUID(),
            data.shopify_domain,
            data.topic,
            JSON.stringify(data.payload),
            JSON.stringify(data.response),
            data.status
        ).run();
    } catch (e) {
        console.error("[Rioko] Failed to save log:", e);
    }
}

export async function getConfig(request: Request, env: Env): Promise<Env> {
    const shopHeader = request.headers.get("X-Shopify-Shop-Domain");
    if (!shopHeader) return env;

    try {
        if (!env.DB) throw new Error("D1 Database binding 'DB' not found");

        const integration: any = await env.DB.prepare(
            "SELECT * FROM integrations WHERE shopify_domain = ?"
        ).bind(shopHeader).first();

        if (integration) {
            console.log(`[Rioko] Dynamic config loaded for ${shopHeader}`);
            return {
                ...env,
                SHOPIFY_SHOP_DOMAIN: integration.shopify_domain || env.SHOPIFY_SHOP_DOMAIN,
                SHOPIFY_ACCESS_TOKEN: integration.shopify_token || env.SHOPIFY_ACCESS_TOKEN,
                SHOPIFY_WEBHOOK_SECRET: integration.shopify_webhook_secret || env.SHOPIFY_WEBHOOK_SECRET,
                SHOPIFY_API_VERSION: integration.shopify_api_version || env.SHOPIFY_API_VERSION,
                INVOICEXPRESS_ACCOUNT_NAME: integration.ix_account_name || env.INVOICEXPRESS_ACCOUNT_NAME,
                INVOICEXPRESS_API_KEY: integration.ix_api_key || env.INVOICEXPRESS_API_KEY,
                INVOICEXPRESS_ENVIRONMENT: integration.ix_environment || env.INVOICEXPRESS_ENVIRONMENT || "production",
                INVOICEXPRESS_TAX_INCLUDED: integration.vat_included !== null ? (integration.vat_included === 1 ? "true" : "false") : env.INVOICEXPRESS_TAX_INCLUDED,
                INVOICEXPRESS_AUTO_FINALIZE: integration.auto_finalize !== null ? (integration.auto_finalize === 1 ? "true" : "false") : env.INVOICEXPRESS_AUTO_FINALIZE,
            };
        }
    } catch (e) {
        console.error("[Rioko] Database error, falling back to static config:", e);
    }

    return env;
}

export async function isIdempotent(orderId: number | string, env: Env): Promise<string | null> {
    const key = `shopify_order:${orderId}`;
    return await env.INVOICE_KV.get(key);
}

export async function markAsInvoiced(orderId: number | string, invoiceId: string, env: Env): Promise<void> {
    const key = `shopify_order:${orderId}`;
    const data = JSON.stringify({
        invoice_id: invoiceId,
        timestamp: new Date().toISOString()
    });
    await env.INVOICE_KV.put(key, data);
}
