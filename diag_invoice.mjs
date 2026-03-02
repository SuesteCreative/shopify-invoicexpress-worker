
const domain = "argumentossalgado.app.invoicexpress.com";
const apiKey = "de8cfeefd42e13b9b412414e1b6e8f0edd91615e";
const invoiceId = "251923629";

async function diag() {
    const authHeaders = {
        "X-InvoiceXpress-API-Key": apiKey,
        "Accept": "application/json"
    };

    console.log(`--- Fetching Invoice Details: ${invoiceId} ---`);
    const res = await fetch(`https://${domain}/invoice_receipts/${invoiceId}.json?api_key=${apiKey}`, { headers: authHeaders });
    if (!res.ok) {
        console.log("NOT FOUND IN invoice_receipts, trying invoices...");
        const res2 = await fetch(`https://${domain}/invoices/${invoiceId}.json?api_key=${apiKey}`, { headers: authHeaders });
        const data = await res2.json();
        console.log("INVOICE DATA:", JSON.stringify(data, null, 2));
    } else {
        const data = await res.json();
        console.log("INVOICE DATA:", JSON.stringify(data, null, 2));
    }
}

diag();
