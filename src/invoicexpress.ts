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

export async function createInvoice(
    env: Env,
    clientId: string,
    order: any
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
            tax: { name: "23%" } // Usually discounts are applied to the highest tax bracket or proportional
        });
    }

    const invoiceBody = {
        invoice: {
            date: new Date().toLocaleDateString('pt-PT').split('/').reverse().join('-'), // YYYY-MM-DD
            due_date: new Date().toLocaleDateString('pt-PT').split('/').reverse().join('-'),
            client: { id: clientId },
            items: items,
            reference: `Shopify Order #${order.order_number}`,
            observations: `Shopify ID: ${order.id}`
        }
    };

    const res = await fetch(`${baseUrl}/invoices.json?api_key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(invoiceBody)
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`InvoiceXpress Error: ${res.status} - ${errText}`);
    }

    const data: any = await res.json();
    return data.invoice.id;
}
