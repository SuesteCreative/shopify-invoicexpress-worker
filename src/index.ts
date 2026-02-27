import { Env, isIdempotent, markAsInvoiced } from "./storage";
import { verifyShopifyWebhook } from "./shopify";
import { extractAndValidateNIF } from "./nif";
import { getOrCreateClient, createDocument, findDocumentByReference, findCreditNoteByReference, createCreditNote } from "./invoicexpress";

// Version: 1.1.1 - Fixed IX API endpoints and base URL
export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);

        // 1. Health check
        if (url.pathname === "/health" && request.method === "GET") {
            return new Response("OK", { status: 200 });
        }

        // 2. Webhook handler: Order Paid
        if (url.pathname === "/webhooks/shopify/orders-paid" && request.method === "POST") {
            const isValid = await verifyShopifyWebhook(request, env.SHOPIFY_WEBHOOK_SECRET);
            if (!isValid) return new Response("Invalid Signature", { status: 401 });

            const order = await request.clone().json<any>();
            const orderId = order.id;

            const existing = await isIdempotent(orderId, env);
            if (existing) {
                return new Response(JSON.stringify({ message: "already invoiced", data: JSON.parse(existing) }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" }
                });
            }

            try {
                const nif = extractAndValidateNIF(order);
                const clientName = `${order.customer?.first_name || ""} ${order.customer?.last_name || ""}`.trim() || order.billing_address?.name || "Client";
                const clientEmail = order.customer?.email || order.email;

                // Anti-duplication check: Check IX directly
                const ixExisting = await findDocumentByReference(env, order.order_number, order.id);
                if (ixExisting) {
                    console.log(`[IX] Document already exists in IX: ${ixExisting}`);
                    await markAsInvoiced(order.id, ixExisting, env);
                    return new Response(JSON.stringify({ message: "Already existed in IX", invoice_id: ixExisting }), { status: 200 });
                }

                const clientId = await getOrCreateClient(env, {
                    name: clientName,
                    email: clientEmail,
                    fiscal_id: nif
                });

                // Create Fatura-Recibo
                const invoiceId = await createDocument(env, clientId, order, "fatura_recibo");

                await markAsInvoiced(orderId, invoiceId, env);

                return new Response(JSON.stringify({ message: "Fatura-Recibo created", invoice_id: invoiceId }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" }
                });
            } catch (error: any) {
                console.error(`Error processing order ${orderId}:`, error.message);
                return new Response(JSON.stringify({ error: error.message }), { status: 500 });
            }
        }

        // 3. Webhook handler: Refund Created
        if (url.pathname === "/webhooks/shopify/refunds-create" && request.method === "POST") {
            const isValid = await verifyShopifyWebhook(request, env.SHOPIFY_WEBHOOK_SECRET);
            if (!isValid) return new Response("Invalid Signature", { status: 401 });

            const refund = await request.clone().json<any>();
            const refundId = refund.id;
            const orderId = refund.order_id;

            // Idempotency for refunds
            const existing = await isIdempotent(`refund_${refundId}`, env);
            if (existing) return new Response("Refund already processed", { status: 200 });

            try {
                const orderRes = await fetch(`https://${env.SHOPIFY_SHOP_DOMAIN}/admin/api/${env.SHOPIFY_API_VERSION}/orders/${orderId}.json`, {
                    headers: { "X-Shopify-Access-Token": env.SHOPIFY_ACCESS_TOKEN }
                });

                if (!orderRes.ok) {
                    const err = await orderRes.text();
                    console.error(`[Shopify] Failed to fetch order ${orderId}: ${orderRes.status} - ${err}`);
                    // Return 200 to Shopify to stop retries if the order doesn't exist anymore
                    if (orderRes.status === 404) return new Response("Order not found, skipping", { status: 200 });
                    throw new Error(`Shopify API Error: ${orderRes.status}`);
                }

                const data: any = await orderRes.json();
                const order = data.order;

                if (!order) {
                    console.error("[Shopify] Order object missing in response:", data);
                    throw new Error("Invalid order data from Shopify");
                }

                // Find the original document in InvoiceXpress
                const originalId = await findDocumentByReference(env, order.order_number, order.id);
                if (!originalId) {
                    console.error(`Original document for order #${order.order_number} not found in IX`);
                    return new Response("Original document not found", { status: 404 });
                }

                const nif = extractAndValidateNIF(order);
                const clientName = `${order.customer?.first_name || ""} ${order.customer?.last_name || ""}`.trim() || "Client";
                const clientEmail = order.customer?.email || order.email;

                // Anti-duplication check for credit notes
                const refundRef = `Refund #${refundId} for Order #${order.order_number}`;
                const cxExisting = await findCreditNoteByReference(env, refundRef);
                if (cxExisting) {
                    console.log(`[IX] Credit Note already exists for refund ${refundId}: ${cxExisting}`);
                    await markAsInvoiced(`refund_${refundId}`, cxExisting, env);
                    return new Response(JSON.stringify({ message: "Refund already in IX", credit_note_id: cxExisting }), { status: 200 });
                }

                const clientId = await getOrCreateClient(env, {
                    name: clientName,
                    email: clientEmail,
                    fiscal_id: nif
                });

                // Create Credit Note
                const creditNoteId = await createCreditNote(env, clientId, originalId, order, refund);

                await markAsInvoiced(`refund_${refundId}`, creditNoteId, env);

                return new Response(JSON.stringify({ message: "Credit Note created", credit_note_id: creditNoteId }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" }
                });
            } catch (error: any) {
                console.error(`Error processing refund ${refundId}:`, error.message);
                return new Response(JSON.stringify({ error: error.message }), { status: 500 });
            }
        }

        return new Response("Not Found", { status: 404 });
    },
};
