export interface Env {
    INVOICE_KV: KVNamespace;
    DB: D1Database;
    SHOPIFY_WEBHOOK_SECRET: string;
    SHOPIFY_ACCESS_TOKEN: string;
    SHOPIFY_SHOP_DOMAIN: string;
    SHOPIFY_API_VERSION: string;
    INVOICEXPRESS_ACCOUNT_NAME: string;
    INVOICEXPRESS_API_KEY: string;
    INVOICEXPRESS_TAX_INCLUDED?: string; // "true" or "false"
    INVOICEXPRESS_AUTO_FINALIZE?: string; // "true" or "false"
}

export async function getConfig(request: Request, env: Env): Promise<Env> {
    const shopHeader = request.headers.get("X-Shopify-Shop-Domain");
    if (!shopHeader) return env;

    try {
        const integration: any = await env.DB.prepare(
            "SELECT * FROM integrations WHERE shopify_domain = ?"
        ).bind(shopHeader).first();

        if (integration) {
            console.log(`[Rioko] Dynamic config loaded for ${shopHeader}`);
            return {
                ...env,
                SHOPIFY_SHOP_DOMAIN: integration.shopify_domain,
                SHOPIFY_ACCESS_TOKEN: integration.shopify_token,
                INVOICEXPRESS_ACCOUNT_NAME: integration.ix_account_name,
                INVOICEXPRESS_API_KEY: integration.ix_api_key,
                INVOICEXPRESS_TAX_INCLUDED: integration.vat_included === 1 ? "true" : "false",
                INVOICEXPRESS_AUTO_FINALIZE: integration.auto_finalize === 1 ? "true" : "false",
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
