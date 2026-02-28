import { Env, isIdempotent, markAsInvoiced } from "./storage";
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

    // Country mapping: Prefer ISO codes as requested
    let country = order.billing_address?.country_code || order.billing_address?.country || "PT";
    if (country.toLowerCase() === "portugal") country = "PT";
    if (country.toLowerCase() === "spain") country = "ES";

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
                // Anti-duplication check: Check IX directly
                const ixRef = `Order #${order.order_number} (ID: ${order.id})`;
                const ixExisting = await findDocumentDetailsByReference(env, ixRef);
                if (ixExisting) {
                    console.log(`[IX] Document already exists in IX: ${ixExisting.id}`);
                    await markAsInvoiced(order.id, ixExisting.id, env);
                    return new Response(JSON.stringify({ message: "Already existed in IX", invoice_id: ixExisting.id }), { status: 200 });
                }

                const clientMetadata = mapClientMetadata(order);
                const clientId = await getOrCreateClient(env, clientMetadata);

                // Create Fatura-Recibo
                const invoiceId = await createDocument(env, clientId, order, clientMetadata, "fatura_recibo");

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
                console.log(`[Shopify] Processing refund ${refundId} (Order ${orderId})`);
                const orderRes = await fetch(`https://${env.SHOPIFY_SHOP_DOMAIN}/admin/api/${env.SHOPIFY_API_VERSION}/orders/${orderId}.json`, {
                    headers: { "X-Shopify-Access-Token": env.SHOPIFY_ACCESS_TOKEN }
                });

                if (!orderRes.ok) {
                    const err = await orderRes.text();
                    console.error(`[Shopify] Failed to fetch order ${orderId}: ${orderRes.status} - ${err}`);
                    if (orderRes.status === 403) {
                        throw new Error("ACCESS_DENIED: App lacks 'Protected Customer Data' permissions. Please enable them in Shopify App settings.");
                    }
                    if (orderRes.status === 404) return new Response("Order not found, skipping", { status: 200 });
                    throw new Error(`Shopify API Error: ${orderRes.status}`);
                }

                const data: any = await orderRes.json();
                const order = data.order;
                if (!order) throw new Error("Invalid order data from Shopify");

                // Anti-duplication check for credit notes
                const refundRef = `Refund #${refundId} for Order #${order.order_number}`;
                const cxExisting = await findCreditNoteByReference(env, refundRef);
                if (cxExisting) {
                    console.log(`[IX] Credit Note already exists for refund ${refundId}: ${cxExisting}`);
                    await markAsInvoiced(`refund_${refundId}`, cxExisting, env);
                    return new Response(JSON.stringify({ message: "Refund already in IX", credit_note_id: cxExisting }), { status: 200 });
                }

                const clientMetadata = mapClientMetadata(order);
                const clientId = await getOrCreateClient(env, clientMetadata);

                // Create Credit Note
                const originalRef = `Order #${order.order_number} (ID: ${order.id})`;
                const creditNoteId = await createCreditNote(env, clientId, originalRef, order, refund, clientMetadata);

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
