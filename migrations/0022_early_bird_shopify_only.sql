-- Early bird is ON by default only for Shopify→InvoiceXpress merchants.
-- The 0005b backfill + Clerk user.created webhook previously seeded early_bird=1
-- for every user regardless of integration. Reset it to 0 for anyone who is NOT
-- a Shopify merchant (no shopify connection and no legacy integrations row).
-- Shopify merchants keep 1; non-Shopify (Lodgify, Stripe→Moloni) go back to 0
-- and get early bird only when an admin enables it manually.
--
-- "Shopify merchant" = a shopify connection in the new multi-source model, OR any
-- row in the legacy `integrations` table (that table is the old Shopify→IX-only
-- model and has no source_kind column, so its mere presence means Shopify).
UPDATE subscriptions
SET early_bird = 0, updated_at = CURRENT_TIMESTAMP
WHERE early_bird = 1
  AND user_id NOT IN (SELECT user_id FROM connections WHERE source_kind = 'shopify')
  AND user_id NOT IN (SELECT user_id FROM integrations);
