# Shopify to InvoiceXpress Cloudflare Worker (Rioko 2.0 Engine)

A high-performance, production-ready integration that automatically syncs Shopify orders with InvoiceXpress.

## 🚀 Key Features

- **Bulletproof Reliability**: Uses a dual-layer idempotency system (Cloudflare KV + D1 SQL Database) to strictly ensure **1 Order = 1 Invoice**, even with concurrent webhooks.
- **D1 Database Persistence**: Tracks every processed order and refund in a transactional database.
- **PT-PT Professional Dashboard**: A premium, localized interface for managing connections and rules.
- **Smart VAT Engine**: Intelligent tax mapping with automatic back-calculation for "VAT Included" stores.
- **Fiscal Compliance**: Automatic injection of full tax exemption reasons (M01, M25, etc.) in document observations.
- **Sandbox Support**: Easy switching between Production and Sandbox test environments.
- **Privacy-First Design**: Secure NIF extraction and local memory for processing refunds without sensitive data access.

---

## 🛠️ Rioko 2.0 Dashboard Setup

The easiest way to manage this integration is through the **Rioko Command Center**.

### Step 1: Ligação Shopify
- **Domínio**: O seu subdomínio `.myshopify.com`.
- **Admin Token**: Gerado nas definições de "Custom Apps" do Shopify.
- **Webhook Secret**: Encontrado em Definições > Notificações > Webhooks.

### Step 2: Conexão InvoiceXpress
- **Account Name**: O slug da sua conta (ex: `a-minha-empresa`).
- **API Key**: Disponível em Definições de Conta > API.
- **Ambiente**: Escolha entre `production` ou `sandbox`.

### Step 3: Definições de Integração
- **IVA Incluído**: Ative se os preços da sua loja Shopify já tiverem imposto.
- **Auto Finalizar**: Se ativo, as faturas são emitidas e finalizadas imediatamente.
- **Razão de Isenção**: O motivo legal padrão para faturas com 0% de IVA.

---

## 🏗️ Technical Architecture

- **Runtime**: Cloudflare Workers
- **Database**: Cloudflare D1 (SQL)
- **Data Memory**: Cloudflare KV (Eventually Consistent Lookup)
- **Validation**: Manual webhook HMAC-SHA256 signature verification.

### Data Model (D1)
- `integrations`: Stores client credentials and business rules.
- `processed_orders`: High-consistency table for atomic transaction tracking.
- `logs`: Full diagnostic history of all incoming events.

---

## 📜 Professional Documentation & Compliance

As of **v3.2.0**, the engine is fully compliant with modern fiscal reporting requirements. All tax exemptions are explicitly stated in the document observations with their full legal wording, ensuring clarity for both customers and tax authorities.

**Developed by [Kapta](https://kapta.pt)**
