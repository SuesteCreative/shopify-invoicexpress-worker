# 📜 Shopify-InvoiceXpress Integration Changelog

## 🚀 Version 1.1.2 (Latest) - February 28, 2026

### ✨ New Features
- **Hold-on-Draft Refunds**: Implemented a "Hold" system for refunds. If an invoice is still a Draft in InvoiceXpress, the worker will patiently wait for manual finalization before issuing a Credit Note.
- **Advanced NIF Mining**: Consolidated NIF extraction logic to scan Customer Tags, Customer Notes, and Billing Company fields with algorithm-based Portuguese validation.
- **ISO Country Translation**: Automatic conversion of country names to ISO-2 codes (e.g., `Portugal` → `PT`) for better API compatibility.

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
