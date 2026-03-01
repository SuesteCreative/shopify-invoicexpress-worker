# 📜 Shopify-InvoiceXpress Integration Changelog

## 💎 Version 3.7.4 — Diagnostic UX & Safety Rails — March 1, 2026

### 🛡️ Diagnostic Panel (Hiperadmin)
- **Click-to-Open**: The diagnostic bubble no longer closes when moving the mouse. It now stays open upon clicking the "Pendente" badge, allowing for steady interaction.
- **Safety Rails (2-Step Force)**: The "Forçar Autorização" action now requires two clicks:
    1. First click reveals a red "Tens a certeza? Clica para confirmar" state.
    2. Second click executes the override.
- **Close Action**: Added a dedicated "X" button and an easy-access "Cancelar" link to the diagnostic panel.
- **Visual Feedback**: The help icon now rotates when the panel is open, providing clear state feedback.

### 🎨 Visual & UI Polish
- **Branding Excellence**: Refilled the "Rioko 2.0" version badge for better visual symmetry in the sidebar.
- **Layout Robustness**: Ensured the diagnostic panel stays correctly layered over other UI elements using a high z-index and `AnimatePresence`.

## 💎 Version 3.7.2 — Help Visibility Milestone — March 1, 2026

### 🖥️ Sidebar Navigation
- **Persistent Help Access**: Added the "Ajuda" (Help) link to the main sidebar, making the configuration guide accessible to all users at any time, not just via contextual links.
- **Visual Integration**: Used the standard `BookOpen` icon with a custom amber-themed active state to match the dashboard's design system.

---

## 💎 Version 3.7.1 — Cloudflare Pages Hotfix — March 1, 2026

### 🔧 Fixes
- **Route `/help` hotfix**: Added `export const runtime = 'edge'` to the help page. Cloudflare Pages requires edge runtime for all dynamic or non-static-prerendered routes.
- **Syntax Correction**: Fixed the metadata export on the help page which was accidentally broken during the last deploy.

---

## 💎 Version 3.7.0 — Help Guide & "Onde Encontrar" — March 1, 2026

### 📖 "Guia de Configuração" (/help)
- **New Help Page created**: Step-by-step documentation for all configuration fields (Shopify domain, Access Token, API version, IX Account, API Key, etc.).
- **Visual Placeholders**: Included identified placeholders for real screenshots that will be uploaded by the user to `/public/images/help/`.
- **Anchor Navigation**: Supports direct scrolling to specific fields via hash links (e.g., `/help#ix-api-key`).

### 🗺️ Dashboard UI Improvements
- **"Onde Encontrar" links**: Added a subtle "Onde Encontrar" link next to every configuration field in the 4-step integration process.
- **Contextual Help**: Each link opens the relevant section of the help guide in a new tab.

---

## 💎 Version 3.6.3 — Hiperadmin Visibility & Impersonation-Aware Roles — March 1, 2026

### 🛡️ Security / Role Visibility
- **Hiperadmin is invisible to all other roles**: Superadmins (and below) can no longer see the hiperadmin account in the user list — even when the real logged-in user is a hiperadmin impersonating a superadmin.
- **Impersonation-aware callerRole**: The users API now reads the impersonation cookie to determine filtering rules from the *viewer's* perspective (the impersonated user), not the real admin's. This prevents role escalation through impersonation.
- **Sidebar is impersonation-aware**: The "Regras de Clientes" link (hiperadmin-only) is hidden in the sidebar when a hiperadmin impersonates a non-hiperadmin account.
- **`isSelf` is impersonation-aware**: The "A Sua Conta" badge and action restrictions in the superadmin page now correctly identify the impersonated account as "self", not the real admin.

---

## 💎 Version 3.6.2 — Per-Client POS Mode & Client Rules Page — March 1, 2026

### 🏪 POS Mode (Per-Client Flag)
- **`pos_mode` column added to `integrations` table**: Boolean flag (default `0`) that activates the NIF-matrix name resolution for specific clients.
- **Standard mode (all clients by default)**: Name resolution is now safe and simple — real name or "Consumidor Final". No email-username or NIF-as-name derivations. Eliminates cross-contamination in InvoiceXpress.
- **POS mode (opt-in per client)**: Enables the full fiscal name matrix: name → `NIF XXXXXXXXX` → email username → "Consumidor Final". Configured at the account level, not globally.
- **Benedita Homem de Gouveia**: `pos_mode = 1` activated in production DB. Her POS orders (Shopify POS, no customer names) will correctly create unique IX clients such as "NIF 534174213".

### 👑 Hiperadmin Role
- **New `hiperadmin` role** (top of hierarchy: hiperadmin > superadmin > admin > user).
- **Hiperadmin can**: promote users to superadmin or admin, revoke any role, delete any account, see all users.
- **`isHiperadmin()` helper** added to `admin.ts`.
- **`getRole()` helper** added — returns the user's role string for flexible comparisons.
- **Pedro Porto** promoted to `hiperadmin` in production DB.

### 🖥️ "Regras de Clientes" Page (Hiperadmin Only)
- New page at `/client-rules` visible only to hiperadmin in the sidebar.
- Shows all client accounts with their integration flags as interactive toggles:
  - 🏪 Modo POS (NIF Matrix)
  - 💰 IVA Incluído
  - ⚡ Auto Finalizar
  - 🔗 Webhooks Confirmados
- Changes are saved immediately via `PATCH /api/admin/client-rules`.

### 🎭 Superadmin Page Improvements
- **Role badges** for all tiers: 👑 Hiperadmin (violet), 🔴 Superadmin (rose), 🟡 Admin (amber).
- **Dynamic role buttons**: Hiperadmin sees "Superadmin + Admin" options; Superadmin sees "Admin" only.
- **Avatar icons** change by role.
- **Delete with 2-step confirmation** per user card.

---

## 💎 Version 3.6.1 — Dynamic Greeting, User Delete, Admin Roles — March 1, 2026

### 🙋 Dynamic Dashboard Greeting
- **"Olá, Pedro" was hardcoded**: Now reads first name from the Clerk session (`useUser()`).
- **DB name for impersonation**: Integrations GET now returns `_user_name` from the `users` table so the greeting shows the *impersonated* user's name correctly.

### 🗑️ User Delete (Safe)
- Hiperadmin and superadmin can delete client accounts from D1 (users, integrations, logs).
- **Clerk account is intentionally NOT deleted**: The user can re-register with the same email/Google and will get a fresh D1 record via the `/api/auth/sync` endpoint.
- 2-step confirmation UI (click trash → confirm → cancel).
- Protections: hiperadmin cannot be deleted; admins cannot delete other admins.

---

## 💎 Version 3.6.0 — Superadmin Dashboard Improvements — March 1, 2026

### 🛡️ Role System
- **3-tier system (superadmin > admin > user)** introduced (later expanded to 4 in v3.6.2).
- Role badges in user cards.
- Superadmin can promote/demote users to admin.

---

## 💎 Version 3.5.6 — Fiscal Client Name Matrix — March 1, 2026

### 👤 Client Name Resolution
- **"Consumidor Final" is now reserved for truly anonymous sales** (no name, no email, no NIF).
- **NIF-only sales**: If a client provides only a NIF (common in POS), the system creates an IX client named `"NIF XXXXXXXXX"` — unique, fiscally traceable, and re-usable across purchases.
- **Matrix** (in priority order): Real name → `NIF XXXXXXXXX` → Email username → "Consumidor Final".

*(Note: In v3.6.2+, this matrix is scoped to `pos_mode = 1` clients only.)*

---

## 💎 Version 3.5.5 — NIF as Primary Client Key — March 1, 2026

### 🔍 InvoiceXpress Client Lookup
- **NIF is now the primary client matching key** (moved before code/email in `isExactMatch`).
- **Step 0 lookup**: Before any name-based search, if a NIF is present, the system calls `GET /clients.json?fiscal_id=XXXXXXXXX` directly. This is the most reliable path for POS orders where email and billing name are absent.
- **Email guard**: Empty emails (`""`) no longer incorrectly match existing clients.

---

## 💎 Version 3.5.0 — Client Identity & NIF Engine — March 1, 2026

### 🪪 NIF / Fiscal ID
- **NIF Patch on Existing Clients**: When an order's note contains a valid NIF but the matching InvoiceXpress client was created without one, the system now automatically issues a `PUT /clients/{id}.json` to update their fiscal ID before creating the invoice.
- **No-NIF tolerance**: The patch is non-blocking — if the IX API rejects the update, the invoice is still created correctly.

### 👤 Client Identity (Guest Checkout Fix)
- **Resolved "Client Portugal" cross-contamination**: Guest checkouts with no Shopify account name caused the fallback `"Client"` to match a generic IX record by email, creating invoices in the wrong name.
- **New name resolution chain** (in priority order):
  1. `customer.first_name + last_name` (account checkout)
  2. `billing_address.name` (guest checkout)
  3. Email username, capitalized (e.g. `benedita.gouveia@mail.pt` → `Benedita Gouveia`)
  4. `"Consumidor Final"` — Portuguese fiscal standard for anonymous buyers

### 🔗 Webhook Management
- **Manual Webhook Confirmation**: New `POST /api/integrations/webhooks-confirm` route. Marks `webhooks_active = 1` in D1 without requiring `write_webhooks` scope — for cases where webhooks were installed manually in Shopify Admin.
- **Confirm button in Passo 2**: The dashboard now shows a secondary amber "Confirmar Instalação Manual" button in the Webhooks step, allowing clients with limited-scope tokens to confirm manual installation.
- **No re-validation on every login**: `webhooks_active` is now preserved correctly in D1 and only updated when the token actually has read access to the webhooks list.

---

## 💎 Version 3.4.0 — 4-Step Onboarding Flow — March 1, 2026

### 🗺️ Dashboard Redesign
- **4-Step Guided Flow**: Split the original 3-step flow into 4 dedicated, focused steps:
  - **Passo 1**: Ligação Shopify (domain + token + API version)
  - **Passo 2**: Criação de Webhooks (webhook secret + install/confirm)
  - **Passo 3**: Conexão InvoiceXpress

### 🪪 NIF / Fiscal ID
- **NIF Patch on Existing Clients**: When an order's note contains a valid NIF but the matching InvoiceXpress client was created without one, the system now automatically issues a `PUT /clients/{id}.json` to update their fiscal ID before creating the invoice.
- **No-NIF tolerance**: The patch is non-blocking — if the IX API rejects the update, the invoice is still created correctly.

### 👤 Client Identity (Guest Checkout Fix)
- **Resolved "Client Portugal" cross-contamination**: Guest checkouts with no Shopify account name caused the fallback `"Client"` to match a generic IX record by email, creating invoices in the wrong name.
- **New name resolution chain** (in priority order):
  1. `customer.first_name + last_name` (account checkout)
  2. `billing_address.name` (guest checkout)
  3. Email username, capitalized (e.g. `benedita.gouveia@mail.pt` → `Benedita Gouveia`)
  4. `"Consumidor Final"` — Portuguese fiscal standard for anonymous buyers

### 🔗 Webhook Management
- **Manual Webhook Confirmation**: New `POST /api/integrations/webhooks-confirm` route. Marks `webhooks_active = 1` in D1 without requiring `write_webhooks` scope — for cases where webhooks were installed manually in Shopify Admin.
- **Confirm button in Passo 2**: The dashboard now shows a secondary amber "Confirmar Instalação Manual" button in the Webhooks step, allowing clients with limited-scope tokens to confirm manual installation.
- **No re-validation on every login**: `webhooks_active` is now preserved correctly in D1 and only updated when the token actually has read access to the webhooks list.

---

## 💎 Version 3.4.0 — 4-Step Onboarding Flow — March 1, 2026

### 🗺️ Dashboard Redesign
- **4-Step Guided Flow**: Split the original 3-step flow into 4 dedicated, focused steps:
  - **Passo 1**: Ligação Shopify (domain + token + API version)
  - **Passo 2**: Criação de Webhooks (webhook secret + install/confirm)
  - **Passo 3**: Conexão InvoiceXpress
  - **Passo 4**: Definições de Integração (save button)
- **Dedicated handlers**: Each step has its own isolated async handler (`handleShopifyConnect`, `handleWebhooksInstall`, `handleIxConnect`, `handleSaveSettings`), replacing the previous monolithic `handleConnect`.
- **Step sealing**: Each step collapses (seals) upon successful completion. Passo 4 seals via `setStep(5)` after save.
- **Smart resume**: On page load, the dashboard intelligently resumes from the correct step based on DB state (`shopify_authorized`, `ix_authorized`, `ix_api_key`).
- **"Integração Concluída" card**: Final green card only appears when all 3 integrations are verified (`shopifyAuthorized && ixAuthorized && webhooksActive`).

### 🔍 Webhook Diagnostics
- **3-pill status panel**: The completion card now shows individual status pills for Shopify, Webhooks, and InvoiceXpress.
- **Preserve-on-error logic**: If `webhooks.json` returns 403/401 (token lacks `read_webhooks`), the system now preserves the existing `webhooks_active` DB value instead of overwriting it with `0`.
- **`webhooks_active` in validate response**: The Shopify validate API now returns `webhooks_active` in its JSON response so the frontend can sync state accurately.

---

## 💎 Version 3.3.0 — Webhook Detection & Diagnostic Panel — March 1, 2026

### 🕵️ Webhook Health Detection
- **Active Shopify Webhook Verification**: The validate route now queries `GET /admin/api/{version}/webhooks.json` to check if the Rioko endpoints (`orders/paid`, `refunds/create`) are registered and pointing to the correct worker URL.
- **Selective Matching**: Only webhooks pointing to the Rioko worker URL are counted as valid — other integrations (e.g. Vendus, Mailchimp) are correctly ignored.
- **`webhooks_active` column**: Added to the `integrations` D1 table. Updated by both the activate route (on install) and validate route (on read).
- **Centralized config**: `RIOKO_CONFIG.workerUrl` and `webhookTopics` moved to `backoffice/src/lib/config.ts` for a single source of truth.

### 🖥️ Dashboard
- **Webhook status state**: `webhooksActive` state added to the dashboard, loaded from DB on mount.
- **Diagnostic pill in status bar**: Added a "Webhooks Shopify" status pill alongside Shopify and InvoiceXpress, with distinct red warning if not installed.
- **Warning banner**: If webhooks are missing, a red banner with actionable instructions appears below the diagnostic row.

---

## 💎 Version 3.2.0 (The Bulletproof Engine) - March 1, 2026

### 🛡️ Core Reliability & Security
- **Strict D1 Idempotency**: Implemented a transactional SQL-backed layer (`processed_orders` table) to prevent duplicate invoice creation. This solves the "Multiple Invoice" issue caused by eventually consistent KV lookups during high-frequency webhooks.
- **Atomic Operations**: Each order/refund event is now registered atomically, ensuring exactly one document per Shopify ID.

### ⚖️ Fiscal & Compliance
- **Full Exemption Descriptions**: Document observations now include the complete descriptive text for tax exemptions (e.g., "M01 - Artigo 16.º, n.º 6 do CIVA") instead of just the code.
- **Enhanced Document Metadata**: Improved layout of observations for better readability on generated PDFs.

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
