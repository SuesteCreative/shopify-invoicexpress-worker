// Use built-in fetch
const domain = "ultramegasonico.macewindu.invoicexpress.com";
const apiKey = "8b30a86ecc847a9212ae4f109741c6943b4696fe";

async function diag() {
    const authHeaders = {
        "X-InvoiceXpress-API-Key": apiKey,
        "Accept": "application/json"
    };

    console.log("--- Fetching Taxes ---");
    const res = await fetch(`https://${domain}/taxes.json?api_key=${apiKey}`, { headers: authHeaders });
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
}

diag();
