# 📜 Shopify-InvoiceXpress Integration Changelog

## � Version 2.0.0 (Global Alpha) - March 1, 2026

### �🚀 Major Breakthroughs (The "Bridge" Era)
- **Dynamic Multi-Client Engine**: The Worker now detects the Shopify `X-Shopify-Shop-Domain` and dynamically pulls integration credentials from Cloudflare D1. 
- **One-Click Activation**: Implemented remote webhook installation. Users can now "Activate & Sync" directly from the dashboard without touching Shopify settings.
- **Persistent Command Center**: Configuration for VAT (Tax-Included) and Auto-Finalize is now saved per user in the database.

### ✨ Visual & UI Refinements
- **Branding Excellence**: Integrated new Rioko and Kapta logos with perfect alignment and scaling.
- **Beta Badge & Stable Branding**: Added "Beta" status and stable versioning (v2.0.0 Stable Build) to the sidebar.
- **Safe Navigation**: Added "Go Back" functionality and "Update" states for completed integration steps.
- **Error Transparency**: Implemented a comprehensive pop-up error system for user-side feedback.

### 🛡️ Under the Hood
- **D1 Nexus**: Migrated from static `wrangler.toml` variables to a persistent SQL-based architecture in Cloudflare D1.
- **Deployment stability**: Optimized Build process (Next.js v15) and synchronized lockfiles for high-speed Cloudflare Pages deployments.
- **Anti-Duplication**: Enhanced idempotency filters that check IX directly before emitting documents.

---

## 📅 Version 1.1.2 - February 28, 2026

### ✨ New Features
- **Official Rioko v2 Branding**: Integrated the official white SVG logo provided by the design team.
- **Hold-on-Draft Refunds**: Implemented a "Hold" system for refunds.
- **Tax-Inclusive Toggle**: Added support for VAT-inclusive pricing via `INVOICEXPRESS_TAX_INCLUDED`.
- **Auto-Finalize Option**: Documents can now be automatically finalized upon creation.

### 🛡️ Bug Fixes & Optimizations
- **VAT Priority Fix**: Re-ordered tax detection to ensure products like "Marcadores" get 23% while "Livros" get 6% (Keywords are now fallbacks).
- **Collision Cleanup**: Re-architected client lookup to use the Direct Name Search API, eliminating "Name already taken" logs and speeding up sync for repeat customers.
- **Tax Mapping Reliability**: Standardized tax names to `IVA6`, `PT23`, and `Isento` to match your IX account precisely.
- **Discount Repair**: Switched from line-item discounts to `global_discount` to fix 422 "Item price must be positive" errors.

---

## 📅 Version 1.1.0 - February 27, 2026
...

### ✨ Initial Core Release
- **Automatic Fatura-Recibo**: Listening to Shopify "Paid" events.
- **Smart Idempotency**: Preventing double-invoicing using KV storage.
- **Workshop Override**: Defaulting workshops to 0% VAT.
- **Basic NIF support**: Extracting from order notes.
