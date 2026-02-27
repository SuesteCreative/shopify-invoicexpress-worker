
const account = 'ultramegasonico';
const apiKey = '8b30a86ecc847a9212ae4f109741c6943b4696fe';
const baseUrl = `https://${account}.macewindu.invoicexpress.com`;

async function findRecent() {
    const headers = {
        'X-InvoiceXpress-API-Key': apiKey,
        'Accept': 'application/json'
    };

    try {
        const res = await fetch(`${baseUrl}/invoice_receipts.json?per_page=10&api_key=${apiKey}`, { headers });
        const data = await res.json();
        console.log("Top 10 Faturas-Recibo:");
        (data.invoice_receipts || []).forEach(d => {
            console.log(`ID: ${d.id} | Ref: "${d.reference}" | Client: ${d.client?.name} | State: ${d.state} | Date: ${d.date}`);
        });
    } catch (e) {
        console.log(`Error: ${e.message}`);
    }
}

findRecent(); 
