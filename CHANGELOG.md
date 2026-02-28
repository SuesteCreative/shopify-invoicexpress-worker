# 📜 Shopify-InvoiceXpress Integration Changelog

## 🚀 Version 1.1.2 (Latest) - February 28, 2026

### ✨ New Features
- **Hold-on-Draft Refunds**: Implemented a "Hold" system for refunds.
- **Tax-Inclusive Toggle**: Added support for VAT-inclusive pricing via `INVOICEXPRESS_TAX_INCLUDED`.
- **Auto-Finalize Option**: Documents can now be automatically finalized upon creation via `INVOICEXPRESS_AUTO_FINALIZE`.
- **Advanced NIF Mining**: Consolidated NIF extraction logic.
- **ISO Country Translation**: Automatic conversion to ISO-2 codes.

### 🛡️ Bug Fixes & Optimizations
- **VAT Priority Fix**: Re-ordered tax detection to ensure products like "Marcadores" get 23% while "Livros" get 6% (Keywords are now fallbacks).
- **Collision Cleanup**: Re-architected client lookup to use the Direct Name Search API, eliminating "Name already taken" logs and speeding up sync for repeat customers.
- **Tax Mapping Reliability**: Standardized tax names to `IVA6`, `PT23`, and `Isento` to match your IX account precisely.
- **Discount Repair**: Switched from line-item discounts to `global_discount` to fix 422 "Item price must be positive" errors.

---

## 📅 Version 1.1.0 - February 27, 2026

### ✨ Initial Core Release
- **Automatic Fatura-Recibo**: Listening to Shopify "Paid" events.
- **Smart Idempotency**: Preventing double-invoicing using KV storage.
- **Workshop Override**: Defaulting workshops to 0% VAT.
- **Basic NIF support**: Extracting from order notes.
