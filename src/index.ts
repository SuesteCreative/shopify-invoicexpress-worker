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

function mapClientMetadata(order: any) {
    const nif = extractAndValidateNIF(order);
    const firstName = order.customer?.first_name || "";
    const lastName = order.customer?.last_name || "";
    const name = `${firstName} ${lastName}`.trim() || order.billing_address?.name || "Client";
    const email = order.customer?.email || order.email;

    // Country mapping: InvoiceXpress expects full names like "Portugal"
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
                const ixRef = `Order #${order.order_number} (ID: ${order.id})`;
                const ixExisting = await findDocumentDetailsByReference(config, ixRef);
                if (ixExisting) {
                    console.log(`[IX] Document already exists in IX: ${ixExisting.id}`);
                    const clientMetadata = mapClientMetadata(order);
                    const clientId = await getOrCreateClient(config, clientMetadata);
                    await markAsInvoiced(order.id, ixExisting.id, config, { clientId, clientMetadata, orderNumber: order.order_number });
                    await saveLog(env, { shopify_domain: shopHeader, topic: "orders/paid", payload: orderId, response: { message: "Already existed in IX", invoice_id: ixExisting.id }, status: 200 });
                    return new Response(JSON.stringify({ message: "Already existed in IX", invoice_id: ixExisting.id }), { status: 200 });
                }

                const clientMetadata = mapClientMetadata(order);
                const clientId = await getOrCreateClient(config, clientMetadata);

                // Create Fatura-Recibo
                const invoiceId = await createDocument(config, clientId, order, clientMetadata, "fatura_recibo");

                await markAsInvoiced(orderId, invoiceId, config, { clientId, clientMetadata, orderNumber: order.order_number });
                await saveLog(env, { shopify_domain: shopHeader, topic: "orders/paid", payload: orderId, response: { invoiceId }, status: 200 });

                return new Response(JSON.stringify({ message: "Fatura-Recibo created", invoice_id: invoiceId }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" }
                });
            } catch (error: any) {
                console.error(`Error processing order ${orderId}:`, error.message);
                await saveLog(env, { shopify_domain: shopHeader, topic: "orders/paid", payload: orderId, response: error.message, status: 500 });
                return new Response(JSON.stringify({ error: error.message }), { status: 500 });
            }
        }

        // 3. Webhook handler: Refund Created
        if (url.pathname === "/webhooks/shopify/refunds-create" && request.method === "POST") {
            const shopHeader = request.headers.get("X-Shopify-Shop-Domain");
            console.log(`[Rioko] Webhook Received: refunds-create for ${shopHeader}`);

            const isValid = await verifyShopifyWebhook(request, config.SHOPIFY_WEBHOOK_SECRET);
            if (!isValid) {
                await saveLog(env, { shopify_domain: shopHeader, topic: "refunds/create", payload: "HIDDEN", response: "Invalid Signature", status: 401 });
                return new Response("Invalid Signature", { status: 401 });
            }

            const refund = await request.clone().json<any>();
            const refundId = refund.id;
            const orderId = refund.order_id;

            // Idempotency for refunds
            const existing = await isIdempotent(`refund_${refundId}`, config);
            if (existing) {
                await saveLog(env, { shopify_domain: shopHeader, topic: "refunds/create", payload: refundId, response: "Refund already processed", status: 200 });
                return new Response("Refund already processed", { status: 200 });
            }

            try {
                // 3. Check for stored metadata in KV (Privacy-First Mapping)
                const kvDataRaw = await isIdempotent(orderId, config);
                let clientId, clientMetadata, orderNumber;

                if (kvDataRaw) {
                    const kvData = JSON.parse(kvDataRaw);
                    clientId = kvData.clientId;
                    clientMetadata = kvData.clientMetadata;
                    orderNumber = kvData.orderNumber;
                }

                if (!clientId || !clientMetadata) {
                    console.log(`[Memory] No metadata found in KV for Order ${orderId}. Falling back to Shopify API...`);
                    // Original fallback (might fail with 401 if missing permissions)
                    const orderRes = await fetch(`https://${config.SHOPIFY_SHOP_DOMAIN}/admin/api/${config.SHOPIFY_API_VERSION}/orders/${orderId}.json`, {
                        headers: { "X-Shopify-Access-Token": config.SHOPIFY_ACCESS_TOKEN }
                    });

                    if (!orderRes.ok) {
                        const err = await orderRes.text();
                        console.error(`[Shopify] Failed to fetch order ${orderId}: ${orderRes.status} - ${err}`);
                        if (orderRes.status === 401 || orderRes.status === 403) {
                            throw new Error("ACCESS_DENIED: Cannot fetch order details for refund. Ensure 'Protected Customer Data' is enabled OR make sure the order was placed AFTER the latest Rioko update.");
                        }
                        if (orderRes.status === 404) return new Response("Order not found, skipping", { status: 200 });
                        throw new Error(`Shopify API Error: ${orderRes.status}`);
                    }

                    const data: any = await orderRes.json();
                    const shopifyOrder = data.order;
                    if (!shopifyOrder) throw new Error("Invalid order data from Shopify");

                    clientId = await getOrCreateClient(config, mapClientMetadata(shopifyOrder));
                    clientMetadata = mapClientMetadata(shopifyOrder);
                    orderNumber = shopifyOrder.order_number;
                }

                console.log(`[Rioko] Using stored metadata for Refund. Client: ${clientMetadata.name}, Order: #${orderNumber}`);

                // Anti-duplication check for credit notes
                const refundRef = `Refund #${refundId} for Order #${orderNumber}`;
                const cxExisting = await findCreditNoteByReference(config, refundRef);
                if (cxExisting) {
                    console.log(`[IX] Credit Note already exists for refund ${refundId}: ${cxExisting}`);
                    await markAsInvoiced(`refund_${refundId}`, cxExisting, config);
                    await saveLog(env, { shopify_domain: shopHeader, topic: "refunds/create", payload: refundId, response: { message: "Refund already in IX", credit_note_id: cxExisting }, status: 200 });
                    return new Response(JSON.stringify({ message: "Refund already in IX", credit_note_id: cxExisting }), { status: 200 });
                }

                // Create Credit Note
                const originalRef = `Order #${orderNumber} (ID: ${orderId})`;
                const creditNoteId = await createCreditNote(config, clientId, originalRef, { order_number: orderNumber, ...refund }, refund, clientMetadata);

                await markAsInvoiced(`refund_${refundId}`, creditNoteId, config);
                await saveLog(env, { shopify_domain: shopHeader, topic: "refunds/create", payload: refundId, response: { creditNoteId }, status: 200 });

                return new Response(JSON.stringify({ message: "Credit Note created", credit_note_id: creditNoteId }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" }
                });
            } catch (error: any) {
                if (error.message === "DOCUMENT_IS_DRAFT") {
                    console.log(`[HOLD] Original document for Order #${orderId} is still a Draft. Credit Note is on hold (Shopify will retry).`);
                    await saveLog(env, { shopify_domain: shopHeader, topic: "refunds/create", payload: refundId, response: "HOLD: Original is Draft", status: 422 });
                    return new Response(JSON.stringify({
                        message: "HOLD: Original document is a Draft. Please finalize it in InvoiceXpress to allow Credit Note creation.",
                        state: "waiting"
                    }), { status: 422 });
                }
                console.error(`Error processing refund ${refundId}:`, error.message);
                await saveLog(env, { shopify_domain: shopHeader, topic: "refunds/create", payload: refundId, response: error.message, status: 500 });
                return new Response(JSON.stringify({ error: error.message }), { status: 500 });
            }
        }

        return new Response("Not Found", { status: 404 });
    },
};
