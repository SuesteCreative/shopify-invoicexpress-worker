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

    // Environment Logic: macewindu for test, empty/production for real
    const suffix = env.INVOICEXPRESS_ENVIRONMENT === "macewindu" ? ".macewindu.invoicexpress.com" : ".invoicexpress.com";
    const domain = account.includes('.') ? account : `${account}${suffix}`;
    const baseUrl = `https://${domain}`;

    const authHeaders = {
        "X-InvoiceXpress-API-Key": apiKey,
        "Content-Type": "application/json",
        "Accept": "application/json"
    };

    const name = clientData.name.trim();
    const email = (clientData.email || "").trim().toLowerCase();
    const fiscalId = (clientData.fiscal_id && clientData.fiscal_id !== "999999990") ? clientData.fiscal_id : null;
    const code = String(clientData.code);

    console.log(`[IX] Identifying client: ${name} (${code}) | Email: ${email} | NIF: ${fiscalId}`);

    // Helper: Exact comparison check
    const isExactMatch = (c: any) =>
        String(c.code) === code ||
        (fiscalId && c.fiscal_id === fiscalId) ||
        (email && c.email?.toLowerCase() === email);

    // 1. Primary Check: Direct Search by Name
    const findRes = await fetch(`${baseUrl}/clients/find-by-name.json?client_name=${encodeURIComponent(name)}&api_key=${apiKey}`, { headers: authHeaders });
    if (findRes.status === 200) {
        const findData: any = await findRes.json();
        const existing = findData.client;
        if (existing && isExactMatch(existing)) {
            console.log(`[IX] Direct match found: ${existing.name} (${existing.id})`);
            return existing.id;
        }
    }

    // 2. Secondary Check: Quick Page 1 Scan
    const listRes = await fetch(`${baseUrl}/clients.json?per_page=100&api_key=${apiKey}`, { headers: authHeaders });
    if (listRes.status === 200) {
        const data: any = await listRes.json();
        const clients = data.clients || [];
        const found = clients.find(isExactMatch);
        if (found) {
            console.log(`[IX] Match found on Page 1: ${found.name} (${found.id})`);
            return found.id;
        }
    }

    // 3. Attempt Creation
    console.log(`[IX] No strict match found. Attempting to create: ${name}`);
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

    // 4. Conflict Disambiguation
    const errTxt = await createRes.text();
    if (errTxt.includes("Nome não está disponível") || createRes.status === 422) {
        const disambiguatedName = `${name} [${code.slice(-4)}]`;
        console.log(`[IX] Name exists but belongs to a different client. Creating: ${disambiguatedName}`);
        const retryCreate = await fetch(`${baseUrl}/clients.json?api_key=${apiKey}`, {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify({
                client: { ...clientData, name: disambiguatedName, code: code, fiscal_id: fiscalId || undefined }
            })
        });
        if (retryCreate.ok) {
            const retryData: any = await retryCreate.json();
            return retryData.client.id;
        }
    }

    throw new Error(`IX Client Error: ${createRes.status} - ${errTxt}`);
}

/**
 * Clears common NIF issues like "PT" prefix or spaces/dashes
 */
function mapTaxName(rate: number | string): string {
    const r = parseFloat(String(rate));
    if (r === 0) return "Isento";
    if (r === 6) return "IVA6";
    if (r === 23) return "PT23";
    return `IVA${r}`; // Fallback
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
    const suffix = env.INVOICEXPRESS_ENVIRONMENT === "macewindu" ? ".macewindu.invoicexpress.com" : ".invoicexpress.com";
    const domain = account.includes('.') ? account : `${account}${suffix}`;
    const baseUrl = `https://${domain}`;
    const authHeaders = {
        "X-InvoiceXpress-API-Key": apiKey,
        "Content-Type": "application/json",
        "Accept": "application/json"
    };

    const isTaxIncluded = env.INVOICEXPRESS_TAX_INCLUDED === "true";

    const items = order.line_items.map((item: any) => {
        // Hierarchy for Item ID: SKU -> Barcode -> Variant ID
        const itemCode = String(item.sku || item.barcode || item.variant_id || item.title).trim();
        const vatRate = determineVATRate(item);
        const rawPrice = parseFloat(item.price);

        // Calculate Net Price if VAT is included in Shopify
        const unitPrice = isTaxIncluded ? (rawPrice / (1 + vatRate / 100)) : rawPrice;

        return {
            name: itemCode,
            description: item.name, // Full product + variant name
            unit_price: unitPrice,
            quantity: item.quantity,
            unit: "service",
            tax: { name: mapTaxName(vatRate) }
        };
    });

    // Handle Shipping
    if (parseFloat(order.shipping_lines?.[0]?.price || "0") > 0) {
        const rawShipping = parseFloat(order.shipping_lines[0].price);
        const shipVat = 23; // Standard shipping VAT
        const shipUnitPrice = isTaxIncluded ? (rawShipping / (1 + shipVat / 100)) : rawShipping;

        items.push({
            name: "Portes de Envio",
            description: order.shipping_lines[0].title,
            unit_price: shipUnitPrice,
            quantity: 1,
            unit: "service",
            tax: { name: mapTaxName(shipVat) }
        });
    }

    // Date format must be dd/mm/yyyy for InvoiceXpress API v2
    const today = new Date();
    const formattedDate = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;

    const hasExemptItems = items.some((i: any) => i.tax.name === "Isento");

    const endpoint = type === "fatura_recibo" ? "invoice_receipts" : "invoices";
    const rootKey = type === "fatura_recibo" ? "invoice_receipt" : "invoice";

    const body: any = {};
    body[rootKey] = {
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
        reference: `Order #${order.order_number}`,
        observations: `Shopify ID: ${order.id}`,
        currency_code: order.currency || "EUR"
    };

    // Apply Discount as Global Discount (Correct for IX API v2)
    if (parseFloat(order.total_discounts || "0") > 0) {
        const rawDiscount = parseFloat(order.total_discounts);
        // We assume global discount follows the average tax or the most common tax. 
        // For simplicity and to match total, we adjust it if taxes are included.
        // If there are multiple taxes, this is an approximation, but better than gross.
        const avgVat = items.length > 0 ? (determineVATRate(order.line_items[0]) || 0) : 0;
        const netDiscount = isTaxIncluded ? (rawDiscount / (1 + avgVat / 100)) : rawDiscount;

        body[rootKey].global_discount = {
            value_type: "absolute",
            value: netDiscount.toFixed(2)
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

    // Auto-Finalize Option
    if (env.INVOICEXPRESS_AUTO_FINALIZE === "true") {
        console.log(`[IX] Auto-finalizing ${type} ${doc.id}...`);
        await finalizeDocument(env, doc.id, endpoint);
    }

    return doc.id;
}

export async function findDocumentDetailsByReference(env: Env, reference: string): Promise<{ id: string, type: string, state: string } | null> {
    const account = env.INVOICEXPRESS_ACCOUNT_NAME;
    const apiKey = env.INVOICEXPRESS_API_KEY;
    const suffix = env.INVOICEXPRESS_ENVIRONMENT === "macewindu" ? ".macewindu.invoicexpress.com" : ".invoicexpress.com";
    const domain = account.includes('.') ? account : `${account}${suffix}`;
    const baseUrl = `https://${domain}`;

    const authHeaders = {
        "X-InvoiceXpress-API-Key": apiKey,
        "Accept": "application/json"
    };

    // Types to search
    const types = [
        { endpoint: "invoice_receipts", list: "invoice_receipts", type: "invoice_receipts" },
        { endpoint: "invoices", list: "invoices", type: "invoices" }
    ];

    for (const t of types) {
        const res = await fetch(`${baseUrl}/${t.endpoint}.json?per_page=100&api_key=${apiKey}`, { headers: authHeaders });
        if (res.status === 200) {
            const data: any = await res.json();
            const found = data[t.list]?.find((d: any) => d.reference === reference);
            if (found) return { id: found.id, type: t.type, state: found.state };
        }
    }

    return null;
}

export async function finalizeDocument(env: Env, docId: string, type: string): Promise<boolean> {
    const account = env.INVOICEXPRESS_ACCOUNT_NAME;
    const apiKey = env.INVOICEXPRESS_API_KEY;
    const suffix = env.INVOICEXPRESS_ENVIRONMENT === "macewindu" ? ".macewindu.invoicexpress.com" : ".invoicexpress.com";
    const domain = account.includes('.') ? account : `${account}${suffix}`;
    const baseUrl = `https://${domain}`;

    const authHeaders = {
        "X-InvoiceXpress-API-Key": apiKey,
        "Content-Type": "application/json",
        "Accept": "application/json"
    };

    // Map internal types to body keys (API endpoints use plural, body uses singular)
    const rootKeyMap: any = {
        "invoice_receipts": "invoice_receipt",
        "invoices": "invoice",
        "credit_notes": "credit_note"
    };
    const rootKey = rootKeyMap[type] || "invoice";

    const res = await fetch(`${baseUrl}/${type}/${docId}/change-state.json?api_key=${apiKey}`, {
        method: "PUT",
        headers: authHeaders,
        body: JSON.stringify({
            [rootKey]: { state: "finalized" }
        })
    });

    if (!res.ok) {
        const err = await res.text();
        console.error(`[IX] Failed to finalize document ${docId}: ${err}`);
        return false;
    }
    return true;
}

export async function findCreditNoteByReference(env: Env, reference: string): Promise<string | null> {
    const account = env.INVOICEXPRESS_ACCOUNT_NAME;
    const apiKey = env.INVOICEXPRESS_API_KEY;
    const suffix = env.INVOICEXPRESS_ENVIRONMENT === "macewindu" ? ".macewindu.invoicexpress.com" : ".invoicexpress.com";
    const domain = account.includes('.') ? account : `${account}${suffix}`;
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
    originalRef: string,
    order: any,
    refund: any,
    clientMetadata: { name: string; email: string; fiscal_id: string | null; code: string }
): Promise<string> {
    const account = env.INVOICEXPRESS_ACCOUNT_NAME;
    const apiKey = env.INVOICEXPRESS_API_KEY;
    const suffix = env.INVOICEXPRESS_ENVIRONMENT === "macewindu" ? ".macewindu.invoicexpress.com" : ".invoicexpress.com";
    const domain = account.includes('.') ? account : `${account}${suffix}`;
    const baseUrl = `https://${domain}`;

    // 1. Get original document details
    console.log(`[IX] Searching for original document with reference: "${originalRef}"`);
    const original = await findDocumentDetailsByReference(env, originalRef);
    if (!original) throw new Error(`Original document for reference "${originalRef}" not found in IX.`);

    const isTaxIncluded = env.INVOICEXPRESS_TAX_INCLUDED === "true";

    const items = refund.refund_line_items.map((ri: any) => {
        const item = ri.line_item;
        const itemCode = String(item.sku || item.barcode || item.variant_id || item.title).trim();
        const vatRate = determineVATRate(item);

        // Calculate unit price from subtotal to include line-level discounts
        const rawSubtotal = ri.subtotal;
        const unitPriceGross = rawSubtotal / ri.quantity;
        const unitPrice = isTaxIncluded ? (unitPriceGross / (1 + vatRate / 100)) : unitPriceGross;

        return {
            name: itemCode,
            description: item.name,
            unit_price: unitPrice,
            quantity: ri.quantity,
            unit: "service",
            tax: { name: mapTaxName(vatRate) }
        };
    });

    // Handle shipping refund if any
    const shippingRefund = refund.order_adjustments?.find((adj: any) => adj.kind === "shipping_refund");
    if (shippingRefund) {
        const shipVat = 23;
        const rawAmount = Math.abs(parseFloat(shippingRefund.amount));
        const netAmount = isTaxIncluded ? (rawAmount / (1 + shipVat / 100)) : rawAmount;

        items.push({
            name: "Shipping Refund",
            description: "Refund of shipping costs",
            unit_price: netAmount,
            quantity: 1,
            unit: "service",
            tax: { name: mapTaxName(shipVat) }
        });
    }

    const today = new Date();
    const formattedDate = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;

    const hasExemptItems = items.some((i: any) => i.tax.name === "Isento");

    const body = {
        credit_note: {
            date: formattedDate,
            owner_invoice_id: original.id,
            tax_exemption: hasExemptItems ? "M99" : undefined,
            client: {
                name: clientMetadata.name,
                code: clientMetadata.code,
                email: clientMetadata.email || undefined,
                fiscal_id: clientMetadata.fiscal_id || undefined
            },
            items: items,
            reference: `Refund #${refund.id} for Order #${order.order_number}`,
            observations: `Shopify Refund ID: ${refund.id}. Original Doc ID: ${original.id}`,
            currency_code: order.currency || "EUR"
        }
    };

    const authHeaders = {
        "X-InvoiceXpress-API-Key": apiKey,
        "Content-Type": "application/json",
        "Accept": "application/json"
    };

    // 2. State Check: If original is Draft, throw a specific Hold error
    if (original.state === "draft") {
        throw new Error("DOCUMENT_IS_DRAFT");
    }

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
    const doc = data.credit_note;
    if (!doc?.id) {
        throw new Error(`InvoiceXpress Credit Note success but ID not found: ${JSON.stringify(data)}`);
    }

    // Auto-Finalize Option for Credit Note
    if (env.INVOICEXPRESS_AUTO_FINALIZE === "true") {
        console.log(`[IX] Auto-finalizing Credit Note ${doc.id}...`);
        await finalizeDocument(env, doc.id, "credit_notes");
    }

    return doc.id;
}
