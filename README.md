# Shopify → InvoiceXpress (Rioko 2.0 Engine)

A high-performance, production-ready integration that automatically syncs Shopify orders with InvoiceXpress, including invoice creation, credit notes, NIF detection, and fiscal compliance.

**Current Version: v3.5.0** | Developed by [Kapta](https://kapta.pt)

---

## 🚀 Key Features

- **Bulletproof Reliability**: Dual-layer idempotency (D1 SQL + KV) — strictly **1 Order = 1 Invoice**, even under concurrent webhooks.
- **4-Step Guided Onboarding**: Clean dashboard flow — Shopify → Webhooks → InvoiceXpress → Settings.
- **Webhook Health Detection**: Real-time check of registered webhooks against the Rioko worker URL.
- **Manual Webhook Confirmation**: If token lacks `write_webhooks`, users can confirm manual installation directly from the dashboard.
- **Smart Client Identity**: Resolves customer names correctly for both account checkouts and guest checkouts.
- **NIF Auto-Patch**: Automatically updates existing InvoiceXpress clients with fiscal IDs found in order notes.
- **Fiscal Compliance**: Full legal text of tax exemption reasons (M01–M99) injected into invoice observations.
- **Smart VAT Engine**: Automatic back-calculation for "VAT Included" stores.
- **Sandbox Support**: Easy toggle between Production and Sandbox InvoiceXpress environments.

---

## 🛠️ Dashboard Setup (Rioko Command Center)

### Passo 1: Ligação Shopify
Connect your Shopify store via Admin API credentials.

| Field | Description |
|---|---|
| **Domínio** | Your `.myshopify.com` subdomain (e.g. `minha-loja.myshopify.com`) |
| **Admin API Token** | Generated in Shopify Admin → Apps → Develop Apps → Custom App. Required scopes: `read_orders`, `read_products`, `write_webhooks` (optional but recommended) |
| **Versão da API** | Shopify API version (default: `2026-01`) |

### Passo 2: Criação de Webhooks
Register Shopify webhooks so Rioko receives order events automatically.

| Field | Description |
|---|---|
| **Webhook Signing Secret** | Found in Shopify Admin → Settings → Notifications → Webhooks (shown as "Your webhooks will be signed with: ...") |

**Automatic install** (requires `write_webhooks` scope): Click "Instalar Webhooks" — Rioko registers both endpoints automatically.

**Manual install** (no scope required): Create the two webhooks manually in Shopify Admin and click "Confirmar Instalação Manual":

| Event | URL |
|---|---|
| Order payment | `https://shopify-invoicexpress-worker.pedrotovarporto.workers.dev/webhooks/shopify/orders-paid` |
| Refund creation | `https://shopify-invoicexpress-worker.pedrotovarporto.workers.dev/webhooks/shopify/refunds-create` |

> ℹ️ The Webhook Signing Secret is **shared across all webhooks** in the store — if you already have other webhooks, the secret is the same.

### Passo 3: Conexão InvoiceXpress
Connect your InvoiceXpress account.

| Field | Description |
|---|---|
| **Nome da Conta** | Your account slug (e.g. `minha-empresa` from `minha-empresa.invoicexpress.com`) |
| **Chave API** | Found in InvoiceXpress → Account Settings → API |
| **Ambiente** | `production` or `sandbox` |

### Passo 4: Definições de Integração
Configure fiscal rules.

| Setting | Description |
|---|---|
| **IVA Incluído** | Enable if your Shopify prices already include VAT |
| **Auto Finalizar** | If enabled, invoices are finalized immediately upon creation |
| **Razão de Isenção** | Default legal reason for 0% VAT items (e.g. M99 — Não sujeito) |

---

## 🧠 NIF Detection Logic

The system extracts the customer's fiscal ID (NIF/VAT) from multiple sources, in priority order:

1. `note_attributes` — Dedicated NIF/VAT fields from Shopify checkout apps
2. `customer.note` — Stored customer note in Shopify
3. `customer.tags` — Customer tags (if NIF is stored there)
4. `order.note` — The general order note (customer-writable at checkout)
5. `billing_address.company` / `billing_address.address2` — Alternative fields

All candidates are validated against the **Portuguese NIF algorithm** before use.

**If the client already exists in InvoiceXpress without a NIF**, the system automatically patches their `fiscal_id` via `PUT /clients/{id}.json` before creating the invoice.

---

## 👤 Client Name Resolution (Guest Checkout)

For orders where `customer.first_name` / `last_name` are empty (guest checkout), the system resolves the client name in priority order:

1. `customer.first_name + last_name`
2. `billing_address.name`
3. Email username, capitalized (`benedita.gouveia@mail.pt` → `Benedita Gouveia`)
4. `"Consumidor Final"` — Portuguese fiscal standard for anonymous buyers

---

## 🏗️ Technical Architecture

| Layer | Technology |
|---|---|
| **Runtime** | Cloudflare Workers (Edge) |
| **Database** | Cloudflare D1 (SQL) |
| **Fast Lookups** | Cloudflare KV (Eventually Consistent) |
| **Dashboard** | Next.js 15 on Cloudflare Pages |
| **Auth** | Clerk (Edge-compatible) |
| **Webhook Auth** | HMAC-SHA256 signature verification |

### Data Model (D1)

```sql
integrations       -- Client credentials, business rules, connection status
processed_orders   -- Atomic idempotency table (1 row per Shopify order/refund)
logs               -- Full diagnostic history of all incoming webhook events
```

### Key columns in `integrations`

| Column | Purpose |
|---|---|
| `shopify_authorized` | Whether Shopify credentials are valid |
| `ix_authorized` | Whether InvoiceXpress credentials are valid |
| `webhooks_active` | Whether Rioko webhooks are registered and active |
| `ix_exemption_reason` | Default VAT exemption code (M01–M99) |

---

## � Shopify Token Scopes Required

| Scope | Purpose | Required? |
|---|---|---|
| `read_orders` | Fetch order details for refund processing | ✅ Yes |
| `read_products` | VAT rate detection | ✅ Yes |
| `write_webhooks` | Auto-register webhooks from dashboard | ⚠️ Recommended |
| `read_webhooks` | Verify webhook registration status | ⚠️ Recommended |

> Without `write_webhooks`, webhooks must be installed manually. Without `read_webhooks`, the dashboard cannot auto-detect if webhooks are active (but preserves the last known state).

---

## 📜 Compliance

As of **v3.5.0**, the engine is fully compliant with Portuguese fiscal requirements:
- Full legal text of all AT exemption reasons (M01–M99) injected into invoice observations
- NIF automatically extracted from order notes and injected into InvoiceXpress client records
- `"Consumidor Final"` used as fallback for anonymous buyers (fiscal standard)

**Developed by [Kapta](https://kapta.pt)**
