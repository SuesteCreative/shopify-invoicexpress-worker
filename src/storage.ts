export interface Env {
    INVOICE_KV: KVNamespace;
    SHOPIFY_WEBHOOK_SECRET: string;
    SHOPIFY_ACCESS_TOKEN: string;
    SHOPIFY_SHOP_DOMAIN: string;
    SHOPIFY_API_VERSION: string;
    INVOICEXPRESS_ACCOUNT_NAME: string;
    INVOICEXPRESS_API_KEY: string;
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
