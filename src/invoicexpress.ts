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

    if (!apiKey) throw new Error("INVOICEXPRESS_API_KEY is not defined in environment variables/secrets");
    if (!account) throw new Error("INVOICEXPRESS_ACCOUNT_NAME is not defined in environment variables");

    const baseUrl = `https://${account}.app.invoicexpress.com`;
    const authHeaders = {
        "X-InvoiceXpress-API-Key": apiKey,
        "Content-Type": "application/json",
        "Accept": "application/json"
    };

    // 1. Search for client by fiscal_id if available
    if (clientData.fiscal_id) {
        const url = `${baseUrl}/clients/find-by-code.json?client_code=${clientData.fiscal_id}&api_key=${apiKey}`;
        const searchRes = await fetch(url, { headers: authHeaders });

        if (searchRes.status === 200) {
            try {
                const data: any = await searchRes.json();
                return data.client.id;
            } catch (e) {
                console.error("Failed to parse IX client search response", e);
            }
        }
    }

    // 2. Search by email as fallback
    const listUrl = `${baseUrl}/clients.json?api_key=${apiKey}`;
    const searchEmailRes = await fetch(listUrl, { headers: authHeaders });

    if (searchEmailRes.status === 200) {
        try {
            const data: any = await searchEmailRes.json();
            const found = data.clients.find((c: any) => c.email === clientData.email);
            if (found) return found.id;
        } catch (e) {
            console.error("Failed to parse IX client list response", e);
        }
    }

    // 3. Create new client
    const createUrl = `${baseUrl}/clients.json?api_key=${apiKey}`;
    const createRes = await fetch(createUrl, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
            client: {
                name: clientData.name,
                email: clientData.email,
                fiscal_id: clientData.fiscal_id || "999999990",
            }
        })
    });

    if (!createRes.ok) {
        const txt = await createRes.text();
        throw new Error(`InvoiceXpress Client Creation Error (${createRes.status}): ${txt}. Used URL: ${createUrl.replace(apiKey, 'REDACTED')}`);
    }

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
    const baseUrl = `https://${account}.app.invoicexpress.com`;
    const authHeaders = {
        "X-InvoiceXpress-API-Key": apiKey,
        "Content-Type": "application/json",
        "Accept": "application/json"
    };

    const items = order.line_items.map((item: any) => ({
        name: item.title,
        description: item.name,
        unit_price: item.price,
        quantity: item.quantity,
        tax: { name: `IVA${determineVATRate(item)}` }
    }));

    if (parseFloat(order.shipping_lines?.[0]?.price || "0") > 0) {
        items.push({
            name: "Shipping",
            description: order.shipping_lines[0].title,
            unit_price: order.shipping_lines[0].price,
            quantity: 1,
            tax: { name: "IVA23" }
        });
    }

    if (parseFloat(order.total_discounts) > 0) {
        items.push({
            name: "Discount",
            description: "Order Discount",
            unit_price: `-${order.total_discounts}`,
            quantity: 1,
            tax: { name: "IVA23" }
        });
    }

    const endpoint = type === "fatura_recibo" ? "invoice_receipts" : "invoices";
    const body = {
        invoice: {
            date: new Date().toLocaleDateString('pt-PT').split('/').reverse().join('-'),
            due_date: new Date().toLocaleDateString('pt-PT').split('/').reverse().join('-'),
            client: { id: clientId },
            items: items,
            reference: `Shopify Order #${order.order_number}`,
            observations: `Shopify ID: ${order.id}`
        }
    };

    const docUrl = `${baseUrl}/${endpoint}.json?api_key=${apiKey}`;
    const res = await fetch(docUrl, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`InvoiceXpress Document Creation Error (${type}, ${res.status}): ${errText}`);
    }

    const data: any = await res.json();
    return data.invoice.id;
}

export async function findDocumentByReference(env: Env, orderNumber: string | number): Promise<string | null> {
    const account = env.INVOICEXPRESS_ACCOUNT_NAME;
    const apiKey = env.INVOICEXPRESS_API_KEY;
    const baseUrl = `https://${account}.app.invoicexpress.com`;
    const reference = `Shopify Order #${orderNumber}`;

    // Search in faturas_recibo (English: invoice_receipts)
    const res = await fetch(`${baseUrl}/invoice_receipts.json?api_key=${apiKey}`);
    if (res.status === 200) {
        const data: any = await res.json();
        const found = data.invoice_receipts?.find((d: any) => d.reference === reference);
        if (found) return found.id;
    }

    // Search in invoices if not found
    const resInv = await fetch(`${baseUrl}/invoices.json?api_key=${apiKey}`);
    if (resInv.status === 200) {
        const data: any = await resInv.json();
        const found = data.invoices?.find((d: any) => d.reference === reference);
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
    const baseUrl = `https://${account}.app.invoicexpress.com`;

    const items = refund.refund_line_items.map((rli: any) => {
        const item = rli.line_item;
        return {
            name: item.title,
            description: item.name,
            unit_price: item.price,
            quantity: rli.quantity,
            tax: { name: `IVA${determineVATRate(item)}` }
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
            tax: { name: "IVA23" }
        });
    }

    const body = {
        invoice: {
            date: new Date().toLocaleDateString('pt-PT').split('/').reverse().join('-'),
            client: { id: clientId },
            items: items,
            reference: `Refund for Order #${order.order_number}`,
            observations: `Original Document ID: ${originalDocumentId}. Shopify Refund ID: ${refund.id}`
        }
    };

    const res = await fetch(`${baseUrl}/credit_notes.json?api_key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`InvoiceXpress Error (Credit Note): ${res.status} - ${errText}`);
    }

    const data: any = await res.json();
    return data.invoice.id;
}
