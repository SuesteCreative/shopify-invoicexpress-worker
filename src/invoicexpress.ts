import { Env } from "./storage";
import { LineItem, determineVATRate } from "./vat";

export interface IXClient {
    id: string;
    name: string;
    fiscal_id: string | null;
    email: string | null;
}

export async function getOrCreateClient(
    env: Env,
    clientData: { name: string; email: string; fiscal_id: string | null }
): Promise<string> {
    const account = env.INVOICEXPRESS_ACCOUNT_NAME;
    const apiKey = env.INVOICEXPRESS_API_KEY;
    const baseUrl = `https://${account}.invoicexpress.com`;

    // 1. Search for client by fiscal_id if available
    if (clientData.fiscal_id) {
        const searchRes = await fetch(`${baseUrl}/clients/find-by-code.json?client_code=${clientData.fiscal_id}&api_key=${apiKey}`);
        if (searchRes.status === 200) {
            const data: any = await searchRes.json();
            return data.client.id;
        }
    }

    // 2. Search by email as fallback
    const searchEmailRes = await fetch(`${baseUrl}/clients.json?api_key=${apiKey}`);
    if (searchEmailRes.status === 200) {
        const data: any = await searchEmailRes.json();
        const found = data.clients.find((c: any) => c.email === clientData.email);
        if (found) return found.id;
    }

    // 3. Create new client
    const createRes = await fetch(`${baseUrl}/clients.json?api_key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            client: {
                name: clientData.name,
                email: clientData.email,
                fiscal_id: clientData.fiscal_id || "999999990", // PT logic: 999999990 is often used for Consumidor Final
                // If fiscal_id is null, IX might require specific handling or default
            }
        })
    });

    const created: any = await createRes.json();
    return created.client.id;
}

export async function createDocument(
    env: Env,
    clientId: string,
    order: any,
    type: "invoice" | "fatura_recibo" = "fatura_recibo"
): Promise<string> {
    const account = env.INVOICEXPRESS_ACCOUNT_NAME;
    const apiKey = env.INVOICEXPRESS_API_KEY;
    const baseUrl = `https://${account}.invoicexpress.com`;

    const items = order.line_items.map((item: any) => ({
        name: item.title,
        description: item.name,
        unit_price: item.price,
        quantity: item.quantity,
        tax: { name: `${determineVATRate(item)}%` }
    }));

    // Add shipping if present
    if (parseFloat(order.shipping_lines?.[0]?.price || "0") > 0) {
        items.push({
            name: "Shipping",
            description: order.shipping_lines[0].title,
            unit_price: order.shipping_lines[0].price,
            quantity: 1,
            tax: { name: "23%" } // Default shipping VAT
        });
    }

    // Add discount as a negative line if any
    if (parseFloat(order.total_discounts) > 0) {
        items.push({
            name: "Discount",
            description: "Order Discount",
            unit_price: `-${order.total_discounts}`,
            quantity: 1,
            tax: { name: "23%" }
        });
    }

    const endpoint = type === "fatura_recibo" ? "faturas_recibo" : "invoices";
    const documentWrapper = type === "fatura_recibo" ? "fatura_recibo" : "invoice";

    const body = {
        [documentWrapper]: {
            date: new Date().toLocaleDateString('pt-PT').split('/').reverse().join('-'),
            due_date: new Date().toLocaleDateString('pt-PT').split('/').reverse().join('-'),
            client: { id: clientId },
            items: items,
            reference: `Shopify Order #${order.order_number}`,
            observations: `Shopify ID: ${order.id}`
        }
    };

    const res = await fetch(`${baseUrl}/${endpoint}.json?api_key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`InvoiceXpress Error (${type}): ${res.status} - ${errText}`);
    }

    const data: any = await res.json();
    return data[documentWrapper].id;
}

export async function findDocumentByReference(env: Env, orderNumber: string | number): Promise<string | null> {
    const account = env.INVOICEXPRESS_ACCOUNT_NAME;
    const apiKey = env.INVOICEXPRESS_API_KEY;
    const baseUrl = `https://${account}.invoicexpress.com`;
    const reference = `Shopify Order #${orderNumber}`;

    // Search in faturas_recibo
    const res = await fetch(`${baseUrl}/faturas_recibo.json?api_key=${apiKey}`);
    if (res.status === 200) {
        const data: any = await res.json();
        // The API returns a list of documents. We need to find the one with the matching reference.
        // Note: InvoiceXpress might have many documents, pagination might be needed for production,
        // but for a lean integration, searching recent ones usually covers the refund case.
        const found = data.faturas_recibo.find((d: any) => d.reference === reference);
        if (found) return found.id;
    }

    // Search in invoices if not found
    const resInv = await fetch(`${baseUrl}/invoices.json?api_key=${apiKey}`);
    if (resInv.status === 200) {
        const data: any = await resInv.json();
        const found = data.invoices.find((d: any) => d.reference === reference);
        if (found) return found.id;
    }

    return null;
}

export async function createCreditNote(
    env: Env,
    clientId: string,
    originalDocumentId: string,
    order: any,
    refund: any
): Promise<string> {
    const account = env.INVOICEXPRESS_ACCOUNT_NAME;
    const apiKey = env.INVOICEXPRESS_API_KEY;
    const baseUrl = `https://${account}.invoicexpress.com`;

    // Extract items being refunded
    const items = refund.refund_line_items.map((rli: any) => {
        const item = rli.line_item;
        return {
            name: item.title,
            description: item.name,
            unit_price: item.price,
            quantity: rli.quantity,
            tax: { name: `${determineVATRate(item)}%` }
        };
    });

    // Handle shipping refund if any
    const shippingRefund = refund.order_adjustments?.find((adj: any) => adj.kind === "shipping_refund");
    if (shippingRefund) {
        items.push({
            name: "Shipping Refund",
            description: "Refund of shipping costs",
            unit_price: Math.abs(parseFloat(shippingRefund.amount)).toString(),
            quantity: 1,
            tax: { name: "23%" }
        });
    }

    const body = {
        credit_note: {
            date: new Date().toLocaleDateString('pt-PT').split('/').reverse().join('-'),
            client: { id: clientId },
            items: items,
            reference: `Refund for Order #${order.order_number}`,
            observations: `Original Document ID: ${originalDocumentId}. Shopify Refund ID: ${refund.id}`
        }
    };

    // Note: In InvoiceXpress, credit notes should technically be linked to the original document.
    // However, creating a standalone credit note with the correct items and reference is often 
    // sufficient for simple syncs. Linking requires specific status transitions (original must be closed).

    const res = await fetch(`${baseUrl}/credit_notes.json?api_key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`InvoiceXpress Error (Credit Note): ${res.status} - ${errText}`);
    }

    const data: any = await res.json();
    return data.credit_note.id;
}
