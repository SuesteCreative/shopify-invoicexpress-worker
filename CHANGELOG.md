# 📜 Shopify-InvoiceXpress Integration Changelog

## 💎 Version 3.1.0 (The Professional Rebranding) - March 1, 2026

### 🎨 User Experience & Branding
- **Sandbox Rebranding**: Replaced all technical "macewindu" references with the industry-standard "Sandbox" terminology across the entire dashboard and error messages.
- **Dynamic Sidebar Highlighting**: Implemented a new Client-side navigation system that correctly highlights the active menu item (Dashboard vs Superadmin).
- **PT-PT Localization**: Translated integration statuses ("Autorizado", "Pendente") and step titles to European Portuguese for a more natural user experience.
- **Improved Card Ergonomics**: Adjusted the position of the diagnostic card for better visibility and fixed its branding to "Rioko 2.0 Engine" as requested.
- **Dual-Stack IX Support**: Added automatic fallback detection for modern `.app.invoicexpress.com` domains alongside legacy ones.

## 💎 Version 2.9.0 (The Compliance & Tax Engine) - March 1, 2026

### ⚖️ Tax & Compliance
- **Dynamic Tax Exemption Reason**: Added a new configuration in Step 3 to select the legal reason for 0% VAT (e.g., "M01 - Artigo 16.º"). This ensures all invoices with exempt items are legally compliant with Portuguese AT rules.
- **Exemption Dropdown**: Integrated a curated list of all current InvoiceXpress exemption codes (M01 to M99) with full legal descriptions.
- **Worker Intelligence**: The InvoiceXpress worker now dynamically applies the selected exemption reason to both Invoices and Credit Notes when an item is marked as exempt.

### 🛡️ Reliability & UI Polishing
- **Tooltip Clipping Fix**: Re-architected the Dashboard's layering system to prevent diagnostic tooltips from being cut off by container boundaries.
- **Universal Build Version**: Implemented a dynamic versioning system that syncs the sidebar, logo, and metadata across the entire platform.

---

## 💎 Version 2.8.0 (The Visual & Diagnostic Engine) - March 1, 2026

### 🛡️ Diagnostic & Validation Engine
- **Hybrid Shopify Validation**: Re-engineered the connection motor to handle all Shopify store types, including Quickstart/Test stores. The system now performs a 3-way check (API 2024-2026) to ensure "Authorized" status even in evolving test environments.
- **Real-time Error Tooltips**: Introduced a premium diagnostic layer. Hovering over the "Invalid Credentials" badge now reveals a detailed, centered tooltip with the exact technical reason from Shopify/IX (e.g., "Unauthorized 401", "Domain not found").
- **Automatic Token Sanitization**: Added background `.trim()` and sanitization for API tokens to prevent connection failures caused by invisible white spaces.

### 🎨 Dashboard UI/UX Mastery
- **Step 4: Integration Status Bar**: Implemented a global synchronization indicator at the bottom of the dashboard. It provides a final "Shield Check" (Neon Green) when all 3 steps are fully validated and active.
- **Dynamic Versioning System**: Sidebar and badges now reflect the current build (`v2.8.0`) dynamically from a central configuration.
- **Visual Sealing (Step 3)**: Upon successful activation, the Command Center (Step 3) now seals and collapses automatically, matching the elegant "completed" look of the previous stages.
- **Hollow Icon Logic**: Invalid stages now use a distinct "Hollow Circle" icon to visually differentiate "Filled but Error" from "Completed & Authorized".

### 👑 Superadmin Enhancements
- **Global User Search**: Added a real-time search bar to the Superadmin dashboard to filter clients by Name, Email, or Store Domain.
- **Membership Timeline**: Users are now sorted by "Join Date" (Adesão) by default, with an optional toggle to reverse the order.
- **Self-Impersonation Protection**: Implemented a safeguard that prevents Superadmins from impersonating their own account, clearly labeling the primary admin card.
- **Enhanced Status Indicators**: The Admin list now includes mini-diagnostic tooltips for every client's Shopify and IX connection status.

---

## 🏆 Version 2.3.0 (The Integration & Privacy Milestone) - March 1, 2026

### 🔗 Document Connectivity
- **Smart Credit Note Association**: Implemented `owner_invoice_id` mapping. Refunds (Credit Notes) are now legally and visually linked to their original Fatura-Recibo in the InvoiceXpress dashboard.
- **Back-Calculation Engine**: Added a mathematical layer to automatically reverse-calculate Net prices from Gross totals for stores with "VAT Included" active, solving incompatible test environment errors.

### 🧠 Privacy & Intelligence
- **Privacy-First Mapping (KV Memory)**: The Worker now memorizes customer metadata at the moment of purchase. This allows processing refunds without "hitting" the Shopify API again, bypassing 401 permissions errors and the need for sensitive "Protected Customer Data" scopes.
- **Unified Command Center**: Re-architected Step 3 of the onboarding flow. A single "Guardar & Ativar" action now synchronizes all toggles (VAT, Auto-Finalize) before registering webhooks.

### 🛡️ Reliability & Fixes
- **Reference Streamlining**: Simplified document references (e.g., `Order #1278`) to improve searchability and prevent bracket-matching bugs in the IX API.
- **Auto-Finalize Sync**: Fixed a state-desync bug where toggles wouldn't apply to the active session until the next manual save.

---

## 🛡️ Version 2.2.0 (The Stability & Region Release) - March 1, 2026

### 🌍 Global Reach & Localization
- **Smart Country Mapping**: Implemented a mandatory translation layer for country codes. The system now automatically maps `PT` to `Portugal` to satisfy strict InvoiceXpress API requirements.
- **PT-PT Native UI**: The entire Dashboard and onboarding flow is now fully localized in Portuguese (Portugal).

### ⚙️ API Refinements (SaaS Robustness)
- **Universal Payload Protocol**: Cleaned item payloads to remove deprecated fields like `unit_with_tax`, ensuring 100% compatibility across both Production and `macewindu` (Test) environments.
- **Dynamic Connection States**: The UI now accurately reflects real-time connectivity, displaying "A aguardar ligação..." until the Step 3 webhook activation is confirmed.

### 🎨 Visual & UX Polishing
- **Rioko Branding v2.1**: Adjusted "2.0" version badge alignment for perfect visual symmetry.
- **Kapta Logo Integration**: Reinstated the Kapta logo in the sidebar footer with grayscale-to-color interactive hovers and direct links.
- **Icon Balance**: Optimized Shopify and InvoiceXpress partner logos for better visual hierarchy and updated the IX logo to the latest brand assets.

---

## 💎 Version 2.1.8 (SaaS-Ready & Security Build) - March 1, 2026

### 🛡️ Security & Integrity
- **Webhook Signature Verification**: Finalized HMAC-SHA256 validation. The system now rejects unauthorized Shopify signals using a unique `shopify_webhook_secret` per client.
- **Dynamic API Versioning**: Added support for specific Shopify API versions (e.g., `2024-04`, `2026-01`) manageable via the dashboard.

### SaaS-Ready Architecture
- **Environment Multi-Domain Support**: Implemented a smart toggle for **Production** vs **Test (macewindu)** environments. Account names no longer require manual domain suffixes.
- **Dynamic Worker Routing**: Corrected subdomain detection for Workers (e.g., `pedrotovarporto.workers.dev`), ensuring "Activate & Sync" works across different Cloudflare accounts.

### 🔍 Reliability & Observability
- **Real-time Webhook Audit**: Introduced a **D1 Logging System**. Every incoming signal, signature result, and IX response is now logged in the `logs` table for instant debugging.
- **Fallback Configurations**: Improved the `getConfig` utility to prioritize D1 settings while maintaining `wrangler.toml` defaults as a safe fallback.

### 🎨 UI/UX Mastery (Rioko 2.0)
- **Account Dashboard Fixes**: Fixed logo alignment, footer branding ("Developed by Kapta"), and improved sidebar visual hierarchy.
- **Clerk Identity Integration**: Added profile management, logout controls, and inactivity timeouts for enhanced security.
- **Performance**: Optimized all routes with `Edge Runtime` for lightning-fast Cloudflare Pages execution.

---

##  Version 2.0.0 (Global Alpha) - March 1, 2026

### 🚀 Major Breakthroughs (The "Bridge" Era)
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
