-- Opt-in switches for the Stripe→InvoiceXpress fiscal rework.
--
-- A global merchant is coming onto Stripe→IX with multi-currency sales, OSS,
-- B2B reverse charge, invoice data carried in Stripe metadata, and one IX
-- series per destination country. Everything that rework changes is gated here,
-- one column per correction, so each can be enabled for that merchant and
-- reverted on its own without touching the connections that invoice correctly
-- today (Shopify→IX on the legacy handlers, Stripe→Moloni on another adapter).
--
-- DEFAULT 0 on every column = today's behaviour for every existing row. Enable
-- per merchant from the fiscal console, or by hand:
--   UPDATE integrations SET ix_derive_exemption = 1 WHERE user_id = '...';
--
-- Apply by hand:
--   npx wrangler d1 execute rioko-db --remote --file migrations/0037_stripe_ix_fiscal_flags.sql
-- NEVER `d1 migrations apply` on this database: its ledger is stuck at 0017 and
-- it would replay 0018+ onto columns that already exist.

-- The document's exemption code and legal mention are derived from the buyer's
-- country and VIES instead of the shop-wide `ix_exemption_reason`: non-EU sales
-- get M05 (art. 14 CIVA exports), a VIES-confirmed cross-border EU B2B sale gets
-- `ix_b2b_exemption_reason` plus the article 196 mention, everything else keeps
-- the configured code. Also what makes reverse charge visible at all on the
-- adapter pipeline, which never evaluated it. Never rewrites money: a buyer who
-- paid VAT is invoiced for what they paid.
ALTER TABLE integrations ADD COLUMN ix_derive_exemption INTEGER DEFAULT 0;

-- `createDraft` posts through `createIxInvoiceWithFallback` instead of straight
-- at the API, which is how the legacy Shopify path gets its transient retry
-- against the flaky ix-proxy, its DOC010 sanitized-client fallback, explicit
-- account-tax resolution, and — the reason this exists — the read-back that
-- catches IX storing a foreign OSS rate as "Isento". That is the Zoo de Lagos
-- class of incident, and the adapter pipeline has been blind to it.
ALTER TABLE integrations ADD COLUMN ix_adapter_safety_nets INTEGER DEFAULT 0;

-- VAT is resolved from the Checkout Session or the Stripe Invoice behind a
-- payment, instead of trusting whichever webhook arrived first. A card payment
-- fires session/PI/charge events that all dedup onto the same PaymentIntent,
-- and the PI and charge shapes carry no tax breakdown at all — so the winner of
-- that race decided whether the sale was invoiced with VAT. The same lookup is
-- what makes a re-emission reproduce the original document, since backfill and
-- heal always synthesize a PaymentIntent.
ALTER TABLE integrations ADD COLUMN stripe_tax_from_source INTEGER DEFAULT 0;

-- The buyer's country joins the tag-routing signals, so a rule named
-- `country:AU` routes to that country's series without the merchant having to
-- put the country in Stripe metadata. Metadata still wins, being the same
-- matched string.
ALTER TABLE integrations ADD COLUMN tag_route_by_country INTEGER DEFAULT 0;

-- A configured series name that InvoiceXpress does not know becomes an error
-- instead of a silent fallback to the account's default series. With one series
-- per country, a typo currently files a sale under the wrong country and
-- nothing says so.
ALTER TABLE integrations ADD COLUMN ix_require_series INTEGER DEFAULT 0;

-- JSON map from Stripe metadata keys to invoice fields (buyer name, address,
-- tax id, country, VAT rate, lines). Presence enables it; NULL means the
-- metadata is read only for the NIF/VAT extraction and tag routing it already
-- feeds. Only ever fills blanks — anything the event itself carried wins.
ALTER TABLE integrations ADD COLUMN stripe_metadata_map TEXT;

-- Foreign-currency handling for IX documents. The write schema the IX proxy
-- exposes has no currency field, so what this does is decided by measurement
-- against the sandbox: issue in the paid currency if IX accepts it, otherwise
-- convert at the Stripe balance transaction's own exchange rate — the rate the
-- money actually settled at — and state the original amount and rate in the
-- observations.
ALTER TABLE integrations ADD COLUMN ix_multicurrency INTEGER DEFAULT 0;
