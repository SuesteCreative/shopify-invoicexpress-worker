import { NextRequest, NextResponse } from "next/server";
import { getConfig, isIdempotent, markAsInvoiced, saveLog } from "@/lib/storage";
import { verifyShopifyWebhook } from "@/lib/shopify";
import { extractAndValidateNIF } from "@/lib/nif";
import {
    getOrCreateClient,
    createDocument,
    findDocumentDetailsByReference
} from "@/lib/invoicexpress";

export const runtime = "edge";

function mapClientMetadata(order: any, config: any) {
    const nif = extractAndValidateNIF(order);
    const resolvedName = `${order.customer?.first_name || ""} ${order.customer?.last_name || ""}`.trim() || order.billing_address?.name;
    
    let country = order.billing_address?.country_code || order.billing_address?.country || "PT";
    if (country.toUpperCase() === "PT") country = "Portugal";
    if (country.toUpperCase() === "ES") country = "Spain";

    return {
        name: resolvedName || "Consumidor Final",
        email: order.customer?.email || order.email || "",
        fiscal_id: nif,
        code: String(order.customer?.id || order.id),
        address: order.billing_address?.address1,
        city: order.billing_address?.city,
        zip: order.billing_address?.zip,
        country: country,
        phone: order.customer?.phone || order.billing_address?.phone
    };
}

export async function POST(req: NextRequest) {
    const shopHeader = req.headers.get("X-Shopify-Shop-Domain");
    const config: any = {
        ...process.env,
        ...(await getConfig(shopHeader))
    };

    try {
        const isValid = await verifyShopifyWebhook(req, config.SHOPIFY_WEBHOOK_SECRET);
        if (!isValid) {
            return NextResponse.json({ error: "Invalid Signature" }, { status: 401 });
        }

        const order = await req.json();
        const orderId = order.id;

        const existing = await isIdempotent(orderId);
        if (existing) {
            return NextResponse.json({ message: "already invoiced" }, { status: 200 });
        }

        const ixRef = `Order #${order.order_number}`;
        const ixExisting = await findDocumentDetailsByReference(config, ixRef);
        
        if (ixExisting) {
            const clientMetadata = mapClientMetadata(order, config);
            const clientId = await getOrCreateClient(config, clientMetadata);
            await markAsInvoiced(order.id, ixExisting.id, { clientId, clientMetadata, orderNumber: order.order_number });
            return NextResponse.json({ message: "Already existed in IX", invoice_id: ixExisting.id });
        }

        const clientMetadata = mapClientMetadata(order, config);
        const clientId = await getOrCreateClient(config, clientMetadata);

        const docType = config.INVOICEXPRESS_DOCUMENT_TYPE || "invoice_receipt";
        const invoiceId = await createDocument(config, clientId, order, clientMetadata, docType as any);

        await markAsInvoiced(orderId, invoiceId, { clientId, clientMetadata, orderNumber: order.order_number });
        await saveLog({ shopify_domain: shopHeader, topic: "orders/paid", payload: orderId, response: { invoiceId }, status: 200 });

        return NextResponse.json({ message: "Document created", invoice_id: invoiceId });
    } catch (error: any) {
        console.error(`[Rioko-Vercel] Error:`, error.message);
        await saveLog({ shopify_domain: shopHeader, topic: "orders/paid", payload: "error", response: error.message, status: 500 });
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
