import { Env, isIdempotent, markAsInvoiced, getConfig, saveLog } from "./storage";
import { verifyShopifyWebhook } from "./shopify";
import { extractAndValidateNIF } from "./nif";
import {
    getOrCreateClient,
    createDocument,
    findDocumentDetailsByReference,
    findCreditNoteByReference,
    createCreditNote
} from "./invoicexpress";

function mapClientMetadata(order: any, config: Env) {
    const nif = extractAndValidateNIF(order);
    const firstName = (order.customer?.first_name || "").trim();
    const lastName = (order.customer?.last_name || "").trim();
    const billingName = (order.billing_address?.name || "").trim();
    const email = (order.customer?.email || order.email || "").trim();

    const resolvedName = `${firstName} ${lastName}`.trim() || billingName;
    const isPosMode = config.POS_MODE === "1";

    let name: string;

    if (isPosMode) {
        if (resolvedName) {
            name = resolvedName;
        } else if (nif) {
            name = `NIF ${nif}`;
        } else if (email) {
            name = email.split("@")[0].replace(/[._-]/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
        } else {
            name = "Consumidor Final";
        }
    } else {
        // Classic Engine logic (v3.7.4)
        name = resolvedName || "Consumidor Final";
    }

    // Country mapping
    let country = order.billing_address?.country_code || order.billing_address?.country || "PT";
    if (country.toUpperCase() === "PT") country = "Portugal";
    if (country.toUpperCase() === "ES") country = "Spain";

    return {
        name,
        email,
        fiscal_id: nif,
        code: String(order.customer?.id || order.id),
        address: order.billing_address?.address1,
        city: order.billing_address?.city,
        zip: order.billing_address?.zip,
        country: country,
        phone: order.customer?.phone || order.billing_address?.phone
    };
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);

        // Load Dynamic Config from D1 (fallback to wrangler.toml if not found)
        const config = await getConfig(request, env);

        // 1. Health check
        if (url.pathname === "/health" && request.method === "GET") {
            return new Response("OK", { status: 200 });
        }

        // 2. Webhook handler: Order Paid
        if (url.pathname === "/webhooks/shopify/orders-paid" && request.method === "POST") {
            const shopHeader = request.headers.get("X-Shopify-Shop-Domain");
            console.log(`[Rioko] Webhook Received: orders-paid for ${shopHeader}`);

            const isValid = await verifyShopifyWebhook(request, config.SHOPIFY_WEBHOOK_SECRET);
            if (!isValid) {
                console.error(`[Rioko] Invalid Webhook Signature for ${config.SHOPIFY_SHOP_DOMAIN}.`);
                await saveLog(env, { shopify_domain: shopHeader, topic: "orders/paid", payload: "HIDDEN", response: "Invalid Signature", status: 401 });
                return new Response("Invalid Signature", { status: 401 });
            }

            const order = await request.clone().json<any>();
            const orderId = order.id;

            try {
                const existing = await isIdempotent(orderId, config);
                if (existing) {
                    await saveLog(env, { shopify_domain: shopHeader, topic: "orders/paid", payload: orderId, response: "Already invoiced", status: 200 });
                    return new Response(JSON.stringify({ message: "already invoiced" }), { status: 200 });
                }

                // Anti-duplication check: Check IX directly
                const ixRef = `Order #${order.order_number}`;
                const ixExisting = await findDocumentDetailsByReference(config, ixRef);
                if (ixExisting) {
                    console.log(`[IX] Document already exists in IX: ${ixExisting.id}`);
                    const clientMetadata = mapClientMetadata(order, config);
                    const clientId = await getOrCreateClient(config, clientMetadata);
                    await markAsInvoiced(order.id, ixExisting.id, config, { clientId, clientMetadata, orderNumber: order.order_number });
                    await saveLog(env, { shopify_domain: shopHeader, topic: "orders/paid", payload: orderId, response: { message: "Already existed in IX", invoice_id: ixExisting.id }, status: 200 });
                    return new Response(JSON.stringify({ message: "Already existed in IX", invoice_id: ixExisting.id }), { status: 200 });
                }

                const clientMetadata = mapClientMetadata(order, config);
                const clientId = await getOrCreateClient(config, clientMetadata);

                // Create Document (Fatura-Recibo by default in classic mode, but we use the type if set)
                const docType = config.INVOICEXPRESS_DOCUMENT_TYPE || "invoice_receipt";
                const invoiceId = await createDocument(config, clientId, order, clientMetadata, docType as any);

                await markAsInvoiced(orderId, invoiceId, config, { clientId, clientMetadata, orderNumber: order.order_number });
                await saveLog(env, { shopify_domain: shopHeader, topic: "orders/paid", payload: orderId, response: { invoiceId }, status: 200 });

                return new Response(JSON.stringify({ message: "Document created", invoice_id: invoiceId }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" }
                });
            } catch (error: any) {
                console.error(`Status 500: Error processing order ${orderId}:`, error.message);
                await saveLog(env, { shopify_domain: shopHeader, topic: "orders/paid", payload: orderId, response: error.message, status: 500 });
                return new Response(JSON.stringify({ error: error.message }), { status: 500 });
            }
        }

        // 3. Webhook handler: Refund Created
        if (url.pathname === "/webhooks/shopify/refunds-create" && request.method === "POST") {
            const shopHeader = request.headers.get("X-Shopify-Shop-Domain");

            const isValid = await verifyShopifyWebhook(request, config.SHOPIFY_WEBHOOK_SECRET);
            if (!isValid) {
                await saveLog(env, { shopify_domain: shopHeader, topic: "refunds/create", payload: "HIDDEN", response: "Invalid Signature", status: 401 });
                return new Response("Invalid Signature", { status: 401 });
            }

            const refund = await request.clone().json<any>();
            const refundId = refund.id;
            const orderId = refund.order_id;

            const existing = await isIdempotent(`refund_${refundId}`, config);
            if (existing) return new Response("Refund already processed", { status: 200 });

            try {
                const kvDataRaw = await isIdempotent(orderId, config);
                let clientId, clientMetadata, orderNumber;

                if (kvDataRaw) {
                    const kvData = JSON.parse(kvDataRaw);
                    clientId = kvData.clientId;
                    clientMetadata = kvData.clientMetadata;
                    orderNumber = kvData.orderNumber;
                }

                if (!clientId || !clientMetadata) {
                    const orderRes = await fetch(`https://${config.SHOPIFY_SHOP_DOMAIN}/admin/api/${config.SHOPIFY_API_VERSION}/orders/${orderId}.json`, {
                        headers: { "X-Shopify-Access-Token": config.SHOPIFY_ACCESS_TOKEN }
                    });

                    if (!orderRes.ok) {
                        if (orderRes.status === 404) return new Response("Order not found", { status: 200 });
                        throw new Error(`Shopify API Error: ${orderRes.status}`);
                    }

                    const data: any = await orderRes.json();
                    clientId = await getOrCreateClient(config, mapClientMetadata(data.order, config));
                    clientMetadata = mapClientMetadata(data.order, config);
                    orderNumber = data.order.order_number;
                }

                const refundRef = `Refund #${refundId} for Order #${orderNumber}`;
                const cxExisting = await findCreditNoteByReference(config, refundRef);
                if (cxExisting) {
                    await markAsInvoiced(`refund_${refundId}`, cxExisting, config);
                    return new Response("Already in IX", { status: 200 });
                }

                const creditNoteId = await createCreditNote(config, clientId, `Order #${orderNumber}`, { order_number: orderNumber, id: orderId, ...refund }, refund, clientMetadata);
                await markAsInvoiced(`refund_${refundId}`, creditNoteId, config);
                await saveLog(env, { shopify_domain: shopHeader, topic: "refunds/create", payload: refundId, response: { creditNoteId }, status: 200 });

                return new Response(JSON.stringify({ credit_note_id: creditNoteId }), { status: 200 });
            } catch (error: any) {
                await saveLog(env, { shopify_domain: shopHeader, topic: "refunds/create", payload: refundId, response: error.message, status: 500 });
                return new Response(JSON.stringify({ error: error.message }), { status: 500 });
            }
        }

        return new Response("Not Found", { status: 404 });
    },
};
