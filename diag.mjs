
const account = 'ultramegasonico';
const apiKey = '0e26099bd0c9fde9600f6ed01ec6a9926a350df2';
const baseUrl = `https://${account}.macewindu.invoicexpress.com`;

async function findMe() {
    const headers = {
        'X-InvoiceXpress-API-Key': apiKey,
        'Accept': 'application/json'
    };
    const targetName = "Aaron Kafiki";
    console.log(`Searching for Client: ${targetName}`);

    try {
        const url = `${baseUrl}/clients.json?api_key=${apiKey}`;
        const res = await fetch(url, { headers });
        const data = await res.json();
        const list = data.clients || [];
        const found = list.find(c => c.name.includes(targetName));

        if (found) {
            console.log(`CLIENT FOUND! ID: ${found.id}`);
        } else {
            console.log("CLIENT NOT FOUND in this account.");
        }
    } catch (e) {
        console.log(`Error: ${e.message}`);
    }
}

findMe(); 
