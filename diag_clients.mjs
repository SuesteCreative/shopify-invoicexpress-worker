// Use built-in fetch
const domain = "ultramegasonico.macewindu.invoicexpress.com";
const apiKey = "8b30a86ecc847a9212ae4f109741c6943b4696fe";

async function diag() {
    const authHeaders = {
        "X-InvoiceXpress-API-Key": apiKey,
        "Accept": "application/json"
    };

    console.log("--- Searching for Code '9683182813464' ---");
    const listRes = await fetch(`https://${domain}/clients.json?per_page=100&api_key=${apiKey}`, { headers: authHeaders });
    const listData = await listRes.json();
    const clients = listData.clients || [];
    const byCode = clients.find(c => String(c.code) === "9683182813464");
    if (byCode) {
        console.log("FOUND BY CODE:", JSON.stringify(byCode, null, 2));
    } else {
        console.log("NOT FOUND by code on page 1.");
    }

    console.log("\n--- Searching for 'Client Two' (find-by-name) ---");
    const find2Res = await fetch(`https://${domain}/clients/find-by-name.json?client_name=Client%20Two&api_key=${apiKey}`, { headers: authHeaders });
    const find2Data = await find2Res.json();
    console.log("FIND BY NAME 'Client Two':", JSON.stringify(find2Data, null, 2));

    console.log("\n--- Searching for 'Client' (find-by-name) ---");
    const find3Res = await fetch(`https://${domain}/clients/find-by-name.json?client_name=Client&api_key=${apiKey}`, { headers: authHeaders });
    const find3Data = await find3Res.json();
    console.log("FIND BY NAME 'Client':", JSON.stringify(find3Data, null, 2));
}

diag();
