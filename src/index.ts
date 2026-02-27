import { Env, isIdempotent, markAsInvoiced } from "./storage";
import { verifyShopifyWebhook } from "./shopify";
import { extractAndValidateNIF } from "./nif";
import { getOrCreateClient, createInvoice } from "./invoicexpress";

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);

        // 1. Health check
        if (url.pathname === "/health" && request.method === "GET") {
            return new Response("OK", { status: 200 });
        }

        // 2. Webhook handler
        if (url.pathname === "/webhooks/shopify/orders-paid" && request.method === "POST") {
            // a. Verify HMAC
            const isValid = await verifyShopifyWebhook(request, env.SHOPIFY_WEBHOOK_SECRET);
            if (!isValid) {
                console.error("Invalid Webhook HMAC Signature");
                return new Response("Invalid Signature", { status: 401 });
            }

            const order = await request.clone().json<any>();
            const orderId = order.id;

            // b. Idempotency Check
            const existing = await isIdempotent(orderId, env);
            if (existing) {
                console.log(`Order ${orderId} already processed.`);
                return new Response(JSON.stringify({ message: "already invoiced", data: JSON.parse(existing) }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" }
                });
            }

            try {
                // c. NIF Extraction
                const nif = extractAndValidateNIF(order);
                console.log(`Extracted NIF for order ${orderId}: ${nif || "Consumidor Final"}`);

                // d. InvoiceXpress flow
                const clientName = `${order.customer?.first_name || ""} ${order.customer?.last_name || ""}`.trim() || order.billing_address?.name || "Client";
                const clientEmail = order.customer?.email || order.email;

                const clientId = await getOrCreateClient(env, {
                    name: clientName,
                    email: clientEmail,
                    fiscal_id: nif
                });

                const invoiceId = await createInvoice(env, clientId, order);

                // e. Store idempotency
                await markAsInvoiced(orderId, invoiceId, env);

                return new Response(JSON.stringify({ message: "Invoice created", invoice_id: invoiceId }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" }
                });
            } catch (error: any) {
                console.error(`Error processing order ${orderId}:`, error.message);
                // Return 500 to trigger Shopify retry
                return new Response(JSON.stringify({ error: error.message }), {
                    status: 500,
                    headers: { "Content-Type": "application/json" }
                });
            }
        }

        return new Response("Not Found", { status: 404 });
    },
};
