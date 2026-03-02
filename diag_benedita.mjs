
const domain = "absolutepixelunip.app.invoicexpress.com";
const apiKey = "f8fe750ad3892b70fb2b267d89482aa5fb3ad149532"; // From the test integration query

async function diag() {
    const authHeaders = {
        "X-InvoiceXpress-API-Key": apiKey,
        "Accept": "application/json"
    };

    const email = "test-sync-mar-02@kapta.pt";
    const code = "TEST-CLEAN-CODE-2";
    console.log(`--- Searching for Client with Email: ${email} or Code: ${code} ---`);
    const res = await fetch(`https://${domain}/clients.json?per_page=100&api_key=${apiKey}`, { headers: authHeaders });
    const data = await res.json();
    const clients = data.clients || [];
    const found = clients.find(c => (c.email?.toLowerCase() === email.toLowerCase()) || String(c.code) === code);

    if (found) {
        console.log("FOUND CLIENT:", JSON.stringify(found, null, 2));
    } else {
        console.log("NOT FOUND by email on page 1.");
    }
}

diag();
