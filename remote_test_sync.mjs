import crypto from "crypto";

const domain = "argumentossalgado.app.invoicexpress.com";
const apiKey = "de8cfeefd42e13b9b412414e1b6e8f0edd91615e";
const shopifyDomain = "mwi1cr-7t.myshopify.com";
const webhookSecret = "cd264329d0d88ee013094d7d8118cf66ec9f07bec4bb2cf6b41120a2ef1c825db";
const workerUrl = "http://127.0.0.1:8790/webhooks/shopify/orders-paid";

async function testSync() {
    const authHeaders = {
        "X-InvoiceXpress-API-Key": apiKey,
        "Accept": "application/json",
        "Content-Type": "application/json"
    };

    const randomId = Math.floor(Math.random() * 1000000);
    const email = `test-sync-${randomId}@kapta.pt`;
    const randomNif = "50" + (Math.floor(Math.random() * 9000000) + 1000000); // 9 digit NIF

    // 1. Ensure "Client" exists
    console.log(`--- [1/4] Ensuring Client "Client" exists in IX (${email}) ---`);
    const findRes = await fetch(`https://${domain}/clients.json?per_page=100&api_key=${apiKey}`, { headers: authHeaders });
    const findData = await findRes.json();
    let existing = (findData.clients || []).find(c => c.email === email);

    if (existing) {
        console.log(`Found existing client ${existing.id}, resetting name to "Client"...`);
        await fetch(`https://${domain}/clients/${existing.id}.json?api_key=${apiKey}`, {
            method: "PUT",
            headers: authHeaders,
            body: JSON.stringify({ client: { name: "Client", fiscal_id: null } })
        });
    } else {
        console.log(`Creating fresh "Client" record...`);
        const createRes = await fetch(`https://${domain}/clients.json?api_key=${apiKey}`, {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify({ client: { name: "Client", email: email, code: `TEST-${randomId}`, country: "Portugal" } })
        });
        const created = await createRes.json();
        if (created.errors) throw new Error("IX Create Error: " + JSON.stringify(created.errors));
        existing = created.client;
    }

    if (!existing) throw new Error("Could not find or create client");
    console.log(`[IX] Initial State: Name="${existing.name}", ID=${existing.id}`);

    // 2. Mock Webhook
    console.log(`\n--- [2/4] Simulating Paid Shopify Webhook with real name & NIF ---`);
    const timestamp = Date.now().toString();
    const payloadBody = JSON.stringify({
        id: Math.floor(Math.random() * 90000000) + 10000000,
        contact_email: email,
        customer: {
            email: email,
            first_name: "João",
            last_name: `Sync Test ${randomId}`
        },
        billing_address: {
            first_name: "João",
            last_name: `Sync Test ${randomId}`,
            address1: "Rua do Teste, 123",
            city: "Lisboa",
            zip: "1000-001",
            country_code: "PT"
        },
        note: randomNif,
        total_price: "15.00",
        currency: "EUR",
        line_items: [
            { title: "Test Cleanup Service", quantity: 1, price: "15.00", taxable: true }
        ]
    });

    const hmac = crypto
        .createHmac("sha256", webhookSecret)
        .update(payloadBody, "utf8")
        .digest("base64");

    console.log(`Posting hook to ${workerUrl}...`);
    const workerRes = await fetch(workerUrl, {
        method: "POST",
        headers: {
            "X-Shopify-Shop-Domain": shopifyDomain,
            "X-Shopify-Topic": "orders/paid",
            "X-Shopify-Hmac-Sha256": hmac,
            "Content-Type": "application/json"
        },
        body: payloadBody
    });

    const workerOutput = await workerRes.text();
    console.log(`[Worker HTTP ${workerRes.status}] ${workerOutput}`);

    // 3. Verify Cleanup in IX
    console.log(`\n--- [3/4] Verifying Cleanup in InvoiceXpress... ---`);
    const finalFindRes = await fetch(`https://${domain}/clients.json?per_page=100&api_key=${apiKey}`, { headers: authHeaders });
    const finalFindData = await finalFindRes.json();
    const finalClient = (finalFindData.clients || []).find(c => c.email === email);

    if (finalClient && finalClient.name !== "Client") {
        console.log(`✅ SUCCESS! Client name was updated from "Client" to: "${finalClient.name}"`);
        console.log(`NIF in IX: ${finalClient.fiscal_id || "MISSING"}`);
    } else {
        console.log(`❌ FAILED! Client name is still: "${finalClient?.name || "NOT FOUND"}"`);
    }
}

testSync();
