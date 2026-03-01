import { Env } from "./storage";
import { LineItem, determineVATRate } from "./vat";

export interface IXClient {
    id: string;
    name: string;
    fiscal_id: string | null;
    email: string | null;
}

export async function getBaseUrl(acc: string, e: Env, k: string) {
    const isTestEnv = e.INVOICEXPRESS_ENVIRONMENT === "sandbox" || e.INVOICEXPRESS_ENVIRONMENT === "test" || e.INVOICEXPRESS_ENVIRONMENT === "macewindu";
    const suffix = isTestEnv ? ".macewindu.invoicexpress.com" : ".invoicexpress.com";
    const domain = acc.toLowerCase().endsWith(".invoicexpress.com") ? acc : `${acc}${suffix}`;

    if (!isTestEnv && !acc.includes(".app") && !acc.endsWith(".invoicexpress.com")) {
        try {
            const check = await fetch(`https://${domain}/clients.json?per_page=1&api_key=${k}`, { method: "HEAD" });
            if (check.status === 530 || check.status === 404) return `https://${acc}.app.invoicexpress.com`;
        } catch { return `https://${acc}.app.invoicexpress.com`; }
    }
    return `https://${domain}`;
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

    const baseUrl = await getBaseUrl(account, env, apiKey);

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

function mapTaxName(rate: number | string): string {
    const r = parseFloat(String(rate));
    if (r === 0) return "Isento";
    if (r === 6) return "IVA6";
    if (r === 23) return "PT23";
    return `IVA${r}`;
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
    const baseUrl = await getBaseUrl(account, env, apiKey);

    const authHeaders = {
        "X-InvoiceXpress-API-Key": apiKey,
        "Content-Type": "application/json",
        "Accept": "application/json"
    };

    const isTaxIncluded = env.INVOICEXPRESS_TAX_INCLUDED === "true";

    const items = order.line_items.map((item: any) => {
        const itemCode = String(item.sku || item.barcode || item.variant_id || item.title).trim();
        const vatRate = determineVATRate(item);
        const rawPrice = parseFloat(item.price);
        const unitPrice = isTaxIncluded ? (rawPrice / (1 + vatRate / 100)) : rawPrice;

        return {
            name: itemCode,
            description: item.name,
            unit_price: unitPrice,
            quantity: item.quantity,
            unit: "service",
            tax: { name: mapTaxName(vatRate) }
        };
    });

    if (parseFloat(order.shipping_lines?.[0]?.price || "0") > 0) {
        const rawShipping = parseFloat(order.shipping_lines[0].price);
        const shipVat = 23;
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

    const today = new Date();
    const formattedDate = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;
    const hasExemptItems = items.some((i: any) => i.tax.name === "Isento");

    const endpoint = type === "fatura_recibo" ? "invoice_receipts" : "invoices";
    const rootKey = type === "fatura_recibo" ? "invoice_receipt" : "invoice";

    const exemptionReason = env.INVOICEXPRESS_EXEMPTION_REASON || "M01";
    let observations = `Shopify ID: ${order.id}`;
    if (hasExemptItems) {
        observations += `\nRazão de Isenção: ${exemptionReason}`;
    }

    const body: any = {};
    body[rootKey] = {
        date: formattedDate,
        due_date: formattedDate,
        tax_exemption: hasExemptItems ? exemptionReason : undefined,
        client: {
            name: clientMetadata.name,
            code: clientMetadata.code,
            email: clientMetadata.email || undefined,
            fiscal_id: clientMetadata.fiscal_id || undefined
        },
        items: items,
        reference: `Order #${order.order_number}`,
        observations: observations,
        currency_code: order.currency || "EUR"
    };

    if (parseFloat(order.total_discounts || "0") > 0) {
        const rawDiscount = parseFloat(order.total_discounts);
        const avgVat = items.length > 0 ? (determineVATRate(order.line_items[0]) || 0) : 0;
        const netDiscount = isTaxIncluded ? (rawDiscount / (1 + avgVat / 100)) : rawDiscount;

        body[rootKey].global_discount = {
            value_type: "absolute",
            value: netDiscount.toFixed(2)
        };
    }

    const res = await fetch(`${baseUrl}/${endpoint}.json?api_key=${apiKey}`, {
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
    if (!doc?.id) throw new Error(`InvoiceXpress creation succeeded but ID not found`);

    const isTestEnv = env.INVOICEXPRESS_ENVIRONMENT === "sandbox" || env.INVOICEXPRESS_ENVIRONMENT === "test" || env.INVOICEXPRESS_ENVIRONMENT === "macewindu";
    if (isTestEnv || env.INVOICEXPRESS_AUTO_FINALIZE === "true") {
        console.log(`[IX] Auto-finalizing ${type} ${doc.id}...`);
        await finalizeDocument(env, doc.id, endpoint);
    }

    return doc.id;
}

export async function findDocumentDetailsByReference(env: Env, reference: string): Promise<{ id: string, type: string, state: string } | null> {
    const account = env.INVOICEXPRESS_ACCOUNT_NAME;
    const apiKey = env.INVOICEXPRESS_API_KEY;
    const baseUrl = await getBaseUrl(account, env, apiKey);

    const authHeaders = { "X-InvoiceXpress-API-Key": apiKey, "Accept": "application/json" };
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
    const baseUrl = await getBaseUrl(account, env, apiKey);

    const authHeaders = { "X-InvoiceXpress-API-Key": apiKey, "Content-Type": "application/json", "Accept": "application/json" };
    const rootKeyMap: any = { "invoice_receipts": "invoice_receipt", "invoices": "invoice", "credit_notes": "credit_note" };
    const rootKey = rootKeyMap[type] || "invoice";

    const res = await fetch(`${baseUrl}/${type}/${docId}/change-state.json?api_key=${apiKey}`, {
        method: "PUT",
        headers: authHeaders,
        body: JSON.stringify({ [rootKey]: { state: "finalized" } })
    });

    return res.ok;
}

export async function findCreditNoteByReference(env: Env, reference: string): Promise<string | null> {
    const account = env.INVOICEXPRESS_ACCOUNT_NAME;
    const apiKey = env.INVOICEXPRESS_API_KEY;
    const baseUrl = await getBaseUrl(account, env, apiKey);

    const res = await fetch(`${baseUrl}/credit_notes.json?per_page=100&api_key=${apiKey}`, {
        headers: { "X-InvoiceXpress-API-Key": apiKey, "Accept": "application/json" }
    });
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
    const baseUrl = await getBaseUrl(account, env, apiKey);

    const original = await findDocumentDetailsByReference(env, originalRef);
    if (!original) throw new Error("ORIGINAL_NOT_FOUND");
    if (original.state === "draft") throw new Error("DOCUMENT_IS_DRAFT");

    const isTaxIncluded = env.INVOICEXPRESS_TAX_INCLUDED === "true";
    const items = refund.refund_line_items.map((ri: any) => {
        const item = ri.line_item;
        const vatRate = determineVATRate(item);
        const unitPrice = isTaxIncluded ? ((ri.subtotal / ri.quantity) / (1 + vatRate / 100)) : (ri.subtotal / ri.quantity);

        return {
            name: String(item.sku || item.title),
            description: item.name,
            unit_price: unitPrice,
            quantity: ri.quantity,
            unit: "service",
            tax: { name: mapTaxName(vatRate) }
        };
    });

    const today = new Date();
    const formattedDate = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;
    const hasExemptItems = items.some((i: any) => i.tax.name === "Isento");

    const exemptionReason = env.INVOICEXPRESS_EXEMPTION_REASON || "M01";
    let observations = `Shopify Refund ID: ${refund.id}. Original Doc ID: ${original.id}`;
    if (hasExemptItems) {
        observations += `\nRazão de Isenção: ${exemptionReason}`;
    }

    const body = {
        credit_note: {
            date: formattedDate,
            owner_invoice_id: original.id,
            tax_exemption: hasExemptItems ? exemptionReason : undefined,
            client: { name: clientMetadata.name, email: clientMetadata.email || undefined, fiscal_id: clientMetadata.fiscal_id || undefined },
            items: items,
            reference: `Refund #${refund.id} for Order #${order.order_number}`,
            observations: observations,
            currency_code: order.currency || "EUR"
        }
    };

    const res = await fetch(`${baseUrl}/credit_notes.json?api_key=${apiKey}`, {
        method: "POST",
        headers: { "X-InvoiceXpress-API-Key": apiKey, "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(body)
    });

    if (!res.ok) throw new Error(`Credit Note Error: ${res.status}`);

    const data: any = await res.json();
    if (env.INVOICEXPRESS_AUTO_FINALIZE === "true") {
        await finalizeDocument(env, data.credit_note.id, "credit_notes");
    }

    return data.credit_note.id;
}
