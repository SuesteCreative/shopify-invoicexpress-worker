# Shopify to InvoiceXpress Cloudflare Worker

A production-lean integration that automatically creates InvoiceXpress invoices for paid Shopify orders.

## Features
- **Cloudflare Workers**: High performance, serverless execution.
- **Idempotency**: Prevents duplicate invoices using Cloudflare KV.
- **PT NIF Extraction**: Automatically finds and validates 9-digit Portuguese NIFs from order notes/attributes.
- **Dynamic VAT**: Intelligent VAT mapping (6% for books, 23% for others) based on tax lines or keywords.
- **Secure**: Sensitive keys are managed via Cloudflare Secrets.

## Setup Instructions

### 1. Shopify Configuration
1. In your Shopify Admin, go to **Settings > Apps and sales channels > Develop apps**.
2. Create a new custom app and configure **Admin API scopes**:
   - `read_orders`
3. Install the app and copy the **Admin API access token**.
4. Go to **Settings > Notifications > Webhooks**.
5. Create a webhook for **Order payment**:
   - Event: `orders/paid`
   - Format: `JSON`
   - URL: `https://<your-worker-url>/webhooks/shopify/orders-paid`
   - API version: Select the one matching `SHOPIFY_API_VERSION` in `wrangler.toml`.
6. Copy the **Webhook secret**.

### 2. InvoiceXpress Configuration
1. Log in to your InvoiceXpress account.
2. Go to **Account Settings > API**.
3. Enable API and copy your **API Key**.

### 3. Cloudflare Worker Setup
1. Install dependencies:
   ```bash
   npm install
   ```
2. Create two KV Namespaces (one for dev, one for prod):
   ```bash
   npx wrangler kv:namespace create INVOICE_KV
   npx wrangler kv:namespace create INVOICE_KV --preview
   ```
3. Update `wrangler.toml` with the generated `id`s.
4. Set secrets for production:
   ```bash
   npx wrangler secret put SHOPIFY_ACCESS_TOKEN
   npx wrangler secret put SHOPIFY_WEBHOOK_SECRET
   npx wrangler secret put INVOICEXPRESS_API_KEY
   ```
5. Deploy:
   ```bash
   npm run deploy
   ```

## Local Development & Testing

### Running Locally
```bash
npm run dev
```

### Health Check Task
```bash
curl http://localhost:8787/health
```

### Simulating a Webhook
To test locally, you can use the following curl command (note: HMAC verification will fail unless you disable it for local testing or provide a valid HMAC header):

```bash
curl -X POST http://localhost:8787/webhooks/shopify/orders-paid \
  -H "Content-Type: application/json" \
  -H "X-Shopify-Hmac-Sha256: <HMAC_SIGNATURE>" \
  -d '{
    "id": 12345678,
    "order_number": 1001,
    "email": "customer@example.com",
    "note": "Please use NIF 507421868",
    "line_items": [
      {
        "title": "Clean Code Book",
        "price": "45.00",
        "quantity": 1,
        "tax_lines": [{"rate": 0.06}]
      }
    ],
    "total_discounts": "5.00",
    "shipping_lines": [{"title": "Standard Shipping", "price": "5.00"}]
  }'
```

## VAT Rules
- **6%**: Applied if Shopify tax rate is 0.06 OR if the product title/type/vendor/tag contains "book" or "livro".
- **23%**: Default fallback for everything else.

## NIF Extraction
The worker searches for a 9-digit sequence in the Order Note, Note Attributes, and Address Line 2 (Billing/Shipping). It validates the sequence using the Portuguese NIF checksum. If no valid NIF is found, it defaults to "Consumidor Final" (NIF 999999990).
