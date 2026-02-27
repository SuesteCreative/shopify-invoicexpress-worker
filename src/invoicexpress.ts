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

    // Support macewindu test domain or standard app domain
    const domain = account.includes('.') ? account : `${account}.macewindu.invoicexpress.com`;
    const baseUrl = `https://${domain}`;

    const authHeaders = {
        "X-InvoiceXpress-API-Key": apiKey,
        "Content-Type": "application/json",
        "Accept": "application/json"
    };

    const name = clientData.name.trim();
    const email = (clientData.email || "").trim();
    const fiscalId = clientData.fiscal_id;

    console.log(`[IX] getOrCreateClient: Starting lookup for ${name} (${email}, NIF: ${fiscalId})`);

    // Helper to find client in a list
    const findMatch = (clients: any[]) => {
        return clients.find(c =>
            (fiscalId && c.fiscal_id === fiscalId) ||
            (c.name?.toLowerCase().trim() === name.toLowerCase()) ||
            (email && c.email?.toLowerCase().trim() === email.toLowerCase())
        );
    };

    // 1. Search by NIF if available
    if (fiscalId) {
        try {
            const url = `${baseUrl}/clients/find-by-code.json?client_code=${fiscalId}&api_key=${apiKey}`;
            const res = await fetch(url, { headers: authHeaders });
            if (res.status === 200) {
                const data: any = await res.json();
                if (data?.client?.id) {
                    console.log(`[IX] Found client by NIF: ${data.client.id}`);
                    return data.client.id;
                }
            }
        } catch (e) {
            console.error("[IX] NIF search failed:", e);
        }
    }

    // 2. Search by Name
    try {
        const searchUrl = `${baseUrl}/clients.json?text=${encodeURIComponent(name)}&api_key=${apiKey}`;
        const res = await fetch(searchUrl, { headers: authHeaders });
        if (res.status === 200) {
            const data: any = await res.json();
            const found = findMatch(data.clients || []);
            if (found?.id) {
                console.log(`[IX] Found client by name search: ${found.id}`);
                return found.id;
            }
        }
    } catch (e) {
        console.error("[IX] Name search failed:", e);
    }

    // 3. Create new client
    console.log(`[IX] Client not found. Attempting to create: ${name}`);
    const createRes = await fetch(`${baseUrl}/clients.json?api_key=${apiKey}`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
            client: {
                name: name,
                email: email || undefined,
                fiscal_id: fiscalId || "999999990",
            }
        })
    });

    if (createRes.ok) {
        const created: any = await createRes.json();
        console.log(`[IX] Client created successfully: ${created.client.id}`);
        return created.client.id;
    }

    const txt = await createRes.text();
    console.warn(`[IX] Creation failed: ${createRes.status} - ${txt}`);

    // 4. Emergency Recovery: If name is taken, we MUST find it
    if (txt.includes("Nome não está disponível") || createRes.status === 422) {
        console.log(`[IX] Conflict detected for ${name}. Performing exhaustive deep scan...`);
        // Try searching by name specifically first
        const retryRes = await fetch(`${baseUrl}/clients.json?text=${encodeURIComponent(name)}&per_page=100&api_key=${apiKey}`, { headers: authHeaders });
        if (retryRes.status === 200) {
            const data: any = await retryRes.json();
            const found = (data.clients || []).find((c: any) => c.name?.toLowerCase().trim() === name.toLowerCase());
            if (found?.id) {
                console.log(`[IX] Recovered client ID after conflict: ${found.id}`);
                return found.id;
            }
        }

        // Final fallback: just get the client list and look for the name
        const finalRes = await fetch(`${baseUrl}/clients.json?per_page=100&api_key=${apiKey}`, { headers: authHeaders });
        if (finalRes.status === 200) {
            const data: any = await finalRes.json();
            const found = (data.clients || []).find((c: any) => c.name?.toLowerCase().trim() === name.toLowerCase());
            if (found?.id) return found.id;
        }
    }

    throw new Error(`IX Client Error: ${txt}`);
}

export async function createDocument(
    env: Env,
    clientId: string,
    order: any,
    type: "invoice" | "fatura_recibo" = "fatura_recibo"
): Promise<string> {
    const account = env.INVOICEXPRESS_ACCOUNT_NAME;
    const apiKey = env.INVOICEXPRESS_API_KEY;
    const domain = account.includes('.') ? account : `${account}.macewindu.invoicexpress.com`;
    const baseUrl = `https://${domain}`;
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
        unit: "service",
        tax: { name: `IVA${determineVATRate(item)}` }
    }));

    if (parseFloat(order.shipping_lines?.[0]?.price || "0") > 0) {
        items.push({
            name: "Shipping",
            description: order.shipping_lines[0].title,
            unit_price: order.shipping_lines[0].price,
            quantity: 1,
            unit: "service",
            tax: { name: "IVA23" }
        });
    }

    // Date format must be dd/mm/yyyy for InvoiceXpress API v2
    const today = new Date();
    const formattedDate = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;

    const endpoint = type === "fatura_recibo" ? "invoice_receipts" : "invoices";
    const body: any = {
        invoice: {
            date: formattedDate,
            due_date: formattedDate,
            client: { id: clientId },
            items: items,
            reference: `Shopify Order #${order.order_number}`,
            observations: `Shopify ID: ${order.id}`,
            currency_code: order.currency || "EUR"
        }
    };

    // Add global discount if present, instead of negative item
    if (parseFloat(order.total_discounts) > 0) {
        body.invoice.global_discount = {
            value_type: "amount",
            value: order.total_discounts
        };
    }

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
    const domain = account.includes('.') ? account : `${account}.macewindu.invoicexpress.com`;
    const baseUrl = `https://${domain}`;
    const reference = `Shopify Order #${orderNumber}`;

    const authHeaders = {
        "X-InvoiceXpress-API-Key": apiKey,
        "Accept": "application/json"
    };

    // Search in faturas_recibo (English: invoice_receipts)
    const res = await fetch(`${baseUrl}/invoice_receipts.json?api_key=${apiKey}`, { headers: authHeaders });
    if (res.status === 200) {
        const data: any = await res.json();
        const found = data.invoice_receipts?.find((d: any) => d.reference === reference);
        if (found) return found.id;
    }

    // Search in invoices if not found
    const resInv = await fetch(`${baseUrl}/invoices.json?api_key=${apiKey}`, { headers: authHeaders });
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
    const domain = account.includes('.') ? account : `${account}.macewindu.invoicexpress.com`;
    const baseUrl = `https://${domain}`;

    const items = refund.refund_line_items.map((rli: any) => {
        const item = rli.line_item;
        return {
            name: item.title,
            description: item.name,
            unit_price: item.price,
            quantity: rli.quantity,
            unit: "service",
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

    const today = new Date();
    const formattedDate = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;

    const body = {
        invoice: {
            date: formattedDate,
            client: { id: clientId },
            items: items,
            reference: `Refund for Order #${order.order_number}`,
            observations: `Original Document ID: ${originalDocumentId}. Shopify Refund ID: ${refund.id}`,
            currency_code: order.currency || "EUR"
        }
    };

    const authHeaders = {
        "X-InvoiceXpress-API-Key": apiKey,
        "Content-Type": "application/json",
        "Accept": "application/json"
    };

    const res = await fetch(`${baseUrl}/credit_notes.json?api_key=${apiKey}`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`InvoiceXpress Error (Credit Note): ${res.status} - ${errText}`);
    }

    const data: any = await res.json();
    return data.invoice.id;
}
