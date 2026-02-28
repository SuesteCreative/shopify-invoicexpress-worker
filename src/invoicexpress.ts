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
    clientData: {
        name: string;
        email: string;
        fiscal_id: string | null;
        code: string;
        address?: string;
        city?: string;
        zip?: string;
        country?: string;
        phone?: string;
    }
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
    const email = (clientData.email || "").trim().toLowerCase();
    const fiscalId = (clientData.fiscal_id && clientData.fiscal_id !== "999999990") ? clientData.fiscal_id : null;
    const code = clientData.code;

    console.log(`[IX] Identifying client: ${name} (${code}) | Email: ${email} | NIF: ${fiscalId}`);

    // Fetch the latest client list to find matches locally
    const listRes = await fetch(`${baseUrl}/clients.json?per_page=100&api_key=${apiKey}`, { headers: authHeaders });
    if (listRes.status === 200) {
        const data: any = await listRes.json();
        const clients = data.clients || [];

        // 1. Primary Check: Unique Code (Shopify ID)
        const foundByCode = clients.find((c: any) => c.code === code);
        if (foundByCode) return foundByCode.id;

        // 2. Cross-reference by NIF
        if (fiscalId) {
            const foundByNif = clients.find((c: any) => c.fiscal_id === fiscalId);
            if (foundByNif) return foundByNif.id;
        }
    }

    // 4. Create if truly new
    console.log(`[IX] No match found. Creating: ${name} code: ${code}`);
    const createRes = await fetch(`${baseUrl}/clients.json?api_key=${apiKey}`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
            client: {
                name: name,
                code: code,
                email: email || undefined,
                fiscal_id: fiscalId || undefined,
                address: clientData.address,
                city: clientData.city,
                postal_code: clientData.zip,
                country: clientData.country,
                phone: clientData.phone
            }
        })
    });

    if (createRes.ok) {
        const created: any = await createRes.json();
        return created.client.id;
    }

    // 5. Emergency conflict recovery (if they were created while we were searching or exist beyond page 1)
    const txt = await createRes.text();
    if (txt.includes("Nome não está disponível") || createRes.status === 422) {
        // Try direct name search - more robust than scanning page 1
        const findRes = await fetch(`${baseUrl}/clients/find-by-name.json?client_name=${encodeURIComponent(name)}&api_key=${apiKey}`, { headers: authHeaders });
        if (findRes.status === 200) {
            const data: any = await findRes.json();
            if (data.client?.id) return data.client.id;
        }

        // Final desperation: scan page 1 one last time (in case find-by-name has lag)
        const retryRes = await fetch(`${baseUrl}/clients.json?per_page=100&api_key=${apiKey}`, { headers: authHeaders });
        if (retryRes.status === 200) {
            const data: any = await retryRes.json();
            const found = (data.clients || []).find((c: any) => c.name?.toLowerCase().trim() === name.toLowerCase());
            if (found) return found.id;
        }
    }

    throw new Error(`IX Client Error: ${txt}`);
}

/**
 * Clears common NIF issues like "PT" prefix or spaces/dashes
 */
function cleanNIF(nif: string | null): string | null {
    if (!nif) return null;
    const cleaned = nif.replace(/^(PT|ES|FR|IT)/i, "").replace(/\D/g, "");
    return cleaned.length >= 9 ? cleaned : null;
}

export function extractAndValidateNIF(order: any): string | null {
    // Check note_attributes for specific NIF field
    const nifAttr = order.note_attributes?.find((a: any) =>
        ["nif", "vat", "contribuinte", "fiscal", "tax id"].includes(a.name.toLowerCase())
    );
    if (nifAttr?.value) return cleanNIF(nifAttr.value);

    // Check notes for a 9-digit sequence
    const noteMatch = order.note?.match(/\b\d{9}\b/);
    if (noteMatch) return cleanNIF(noteMatch[0]);

    return null;
}

export async function createDocument(
    env: Env,
    clientId: string,
    order: any,
    clientMetadata: { name: string; email: string; fiscal_id: string | null; code: string },
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

    const items = order.line_items.map((item: any) => {
        // Hierarchy for Item ID: SKU -> Barcode -> Variant ID
        const itemCode = String(item.sku || item.barcode || item.variant_id || item.title).trim();
        const vatRate = determineVATRate(item);

        return {
            name: itemCode,
            description: item.name, // Full product + variant name
            unit_price: parseFloat(item.price),
            quantity: item.quantity,
            unit: "service",
            tax: { name: `IVA${vatRate}` }
        };
    });

    // Handle Shipping
    if (parseFloat(order.shipping_lines?.[0]?.price || "0") > 0) {
        items.push({
            name: "Portes de Envio",
            description: order.shipping_lines[0].title,
            unit_price: parseFloat(order.shipping_lines[0].price),
            quantity: 1,
            unit: "service",
            tax: { name: "IVA23" }
        });
    }

    if (parseFloat(order.total_discounts || "0") > 0) {
        items.push({
            name: "Desconto",
            description: "Desconto aplicado no checkout",
            unit_price: -parseFloat(order.total_discounts),
            quantity: 1,
            unit: "service",
            tax: { name: "IVA0" }
        });
    }

    // Date format must be dd/mm/yyyy for InvoiceXpress API v2
    const today = new Date();
    const formattedDate = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;

    const hasExemptItems = items.some((i: any) => i.tax.name === "IVA0");

    const endpoint = type === "fatura_recibo" ? "invoice_receipts" : "invoices";
    const body: any = {
        invoice: {
            date: formattedDate,
            due_date: formattedDate,
            tax_exemption: hasExemptItems ? "M99" : undefined,
            client: {
                name: clientMetadata.name,
                code: clientMetadata.code,
                email: clientMetadata.email || undefined,
                fiscal_id: clientMetadata.fiscal_id || undefined
            },
            items: items,
            reference: `Order #${order.order_number} (ID: ${order.id})`,
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
    const doc = data.invoice || data.invoice_receipt || data.credit_note;
    if (!doc?.id) {
        console.error("[IX] Unexpected creation response:", data);
        throw new Error(`InvoiceXpress creation succeeded but ID not found in response: ${JSON.stringify(data)}`);
    }
    return doc.id;
}

export async function findDocumentByReference(env: Env, orderNumber: string | number, orderId: string | number): Promise<string | null> {
    const account = env.INVOICEXPRESS_ACCOUNT_NAME;
    const apiKey = env.INVOICEXPRESS_API_KEY;
    const domain = account.includes('.') ? account : `${account}.macewindu.invoicexpress.com`;
    const baseUrl = `https://${domain}`;
    const reference = `Order #${orderNumber} (ID: ${orderId})`;

    const authHeaders = {
        "X-InvoiceXpress-API-Key": apiKey,
        "Accept": "application/json"
    };

    // Search in faturas_recibo (English: invoice_receipts)
    const res = await fetch(`${baseUrl}/invoice_receipts.json?per_page=100&api_key=${apiKey}`, { headers: authHeaders });
    if (res.status === 200) {
        const data: any = await res.json();
        const found = data.invoice_receipts?.find((d: any) => d.reference === reference);
        if (found) return found.id;
    }

    // Search in invoices if not found
    const resInv = await fetch(`${baseUrl}/invoices.json?per_page=100&api_key=${apiKey}`, { headers: authHeaders });
    if (resInv.status === 200) {
        const data: any = await resInv.json();
        const found = data.invoices?.find((d: any) => d.reference === reference);
        if (found) return found.id;
    }

    return null;
}

export async function findCreditNoteByReference(env: Env, reference: string): Promise<string | null> {
    const account = env.INVOICEXPRESS_ACCOUNT_NAME;
    const apiKey = env.INVOICEXPRESS_API_KEY;
    const domain = account.includes('.') ? account : `${account}.macewindu.invoicexpress.com`;
    const baseUrl = `https://${domain}`;

    const authHeaders = {
        "X-InvoiceXpress-API-Key": apiKey,
        "Accept": "application/json"
    };

    const res = await fetch(`${baseUrl}/credit_notes.json?per_page=100&api_key=${apiKey}`, { headers: authHeaders });
    if (res.status === 200) {
        const data: any = await res.json();
        const found = data.credit_notes?.find((d: any) => d.reference === reference);
        if (found) return found.id;
    }

    return null;
}

export async function createCreditNote(
    env: Env,
    clientId: string,
    originalId: string,
    order: any,
    refund: any,
    clientMetadata: { name: string; email: string; fiscal_id: string | null; code: string }
): Promise<string> {
    const account = env.INVOICEXPRESS_ACCOUNT_NAME;
    const apiKey = env.INVOICEXPRESS_API_KEY;
    const domain = account.includes('.') ? account : `${account}.macewindu.invoicexpress.com`;
    const baseUrl = `https://${domain}`;

    const items = refund.refund_line_items.map((ri: any) => {
        const item = ri.line_item;
        const itemCode = String(item.sku || item.barcode || item.variant_id || item.title).trim();
        const vatRate = determineVATRate(item);

        return {
            name: itemCode,
            description: item.name,
            unit_price: parseFloat(item.price),
            quantity: ri.quantity,
            unit: "service",
            tax: { name: `IVA${vatRate}` }
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

    const hasExemptItems = items.some((i: any) => i.tax.name === "IVA0");

    const body = {
        credit_note: {
            date: formattedDate,
            tax_exemption: hasExemptItems ? "M99" : undefined,
            client: {
                name: clientMetadata.name,
                code: clientMetadata.code,
                email: clientMetadata.email || undefined,
                fiscal_id: clientMetadata.fiscal_id || undefined
            },
            items: items,
            reference: `Refund #${refund.id} for Order #${order.order_number}`,
            observations: `Original Document ID: ${originalId}. Shopify Refund ID: ${refund.id}`,
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
    const doc = data.invoice || data.invoice_receipt || data.credit_note;
    if (!doc?.id) {
        throw new Error(`InvoiceXpress Credit Note success but ID not found: ${JSON.stringify(data)}`);
    }
    return doc.id;
}
