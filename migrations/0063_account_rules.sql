-- Per-account rules: what ONE account declares about how its documents are
-- produced, applied by generic code and invisible to every other account.
--
-- NEVER run `wrangler d1 migrations apply` on this database. Its ledger stopped
-- at 0017 and applying would replay everything since. This file goes on by hand:
--   npx wrangler d1 execute rioko-db --remote --file migrations/0063_account_rules.sql
--
-- WHY A TABLE AND NOT ANOTHER FLAG
--
-- Every personalization so far has cost a new global config column or blob key,
-- hand-registered in five separate lists: the `IRequestConfig` type,
-- `synthLegacyConfig`, `CONNECTION_FISCAL_FLAGS`, the console's
-- `FISCAL_CONFIG_KEYS`, and its `DANGEROUS_FIELDS`. Measured 14/09/2026: of the
-- ~24 behaviour switches that exist, eight are enabled on exactly ONE account
-- out of seventeen, and the two newest (`stripe_address_from_charge`,
-- `stripe_line_names_from_product`) are live in the worker and allowlisted by
-- the console API but missing from the console's own field list — nobody
-- finished the fifth list. The ceremony is the reason.
--
-- Worse, the unit was wrong. Bestisafil has ONE intent — "this account's buyer
-- address comes from the payment, not the customer record" — and expressing it
-- took two flags read at three places. A rule here is that intent, with named
-- alternatives, so the code that implements it can reach every layer it has to.
--
-- WHY THIS KEY
--
-- The same triple `product_overrides` (0014), `product_mappings` (0013) and
-- `tag_routing_rules` (0017) are keyed by, and for the same reason: one merchant
-- may run Shopify→InvoiceXpress alongside Stripe→Moloni, and each is its own
-- business decision. It is also the isolation boundary. The leak
-- `projectConnectionBehaviour` exists to stop had one cause — a single shared
-- row a second integration fell back to — and there is no such row here. A rule
-- is reachable only by a run that already declared itself to be that connection;
-- absence resolves to the catalogue's defaults, which are today's behaviour, and
-- never to another account's answer.
--
-- NOT on `connections.behavior_json`, though that column is free: production has
-- ZERO `shopify` rows in `connections`, and 14 of 17 `integrations` rows have no
-- connection row at all. A home there could not address the legacy Shopify fleet.
--
-- NOT in `company_rules` (0035), which is keyed by user alone and holds free-text
-- notes that change no document. Its own migration says enforceable rules do not
-- belong there.
--
-- `value_json` is JSON so a rule can grow parameters without another migration.
-- Today every rule is a plain enum string, and that is enough.
CREATE TABLE IF NOT EXISTS account_rules (
  user_id          TEXT NOT NULL,
  source_kind      TEXT NOT NULL,   -- 'shopify' | 'stripe' | 'stripe_connect' | 'eupago' | 'lodgify'
  destination_kind TEXT NOT NULL,   -- 'invoicexpress' | 'moloni' | 'vendus'
  rule_id          TEXT NOT NULL,   -- a key in src/services/rules-catalogue.ts
  value_json       TEXT NOT NULL,   -- refused on read unless the catalogue parses it
  note             TEXT,            -- why this rule exists, for whoever reads it next
  updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by       TEXT,            -- the operator who wrote it
  PRIMARY KEY (user_id, source_kind, destination_kind, rule_id)
);
