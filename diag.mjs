
const account = 'ultramegasonico';
const apiKey = '8b30a86ecc847a9212ae4f109741c6943b4696fe';
const baseUrl = `https://${account}.macewindu.invoicexpress.com`;

async function findOrder() {
    const headers = {
        'X-InvoiceXpress-API-Key': apiKey,
        'Accept': 'application/json'
    };

    console.log("Searching for Reference containing '1261'...");

    try {
        const res = await fetch(`${baseUrl}/invoice_receipts.json?per_page=100&api_key=${apiKey}`, { headers });
        const data = await res.json();
        const found = (data.invoice_receipts || []).find(d => d.reference && d.reference.includes("1261"));

        if (found) {
            console.log("\n--- ORDER #1261 FOUND ---");
            console.log(`ID: ${found.id} | Client: ${found.client?.name} | Total: ${found.total}`);
            console.log(`Ref: ${found.reference}`);
        } else {
            console.log("\nOrder #1261 NOT found in the last 100 invoice receipts.");
            console.log("Last item in list was:", data.invoice_receipts?.[0]?.reference);
        }
    } catch (e) {
        console.log(`Error: ${e.message}`);
    }
}

findOrder(); 
