-- Correct the attribution 0044 got wrong, and for the reason it got it wrong.
--
-- 0044 decided which connection an existing subscription had been bought for by
-- comparing `integrations.created_at` with `connections.created_at` AS STRINGS.
-- The two tables do not agree on format: SQLite's CURRENT_TIMESTAMP writes
-- `2026-09-08 14:52:25`, our own inserts write `2026-09-08T14:49:59.950Z`, and
-- ' ' (0x20) sorts before 'T' (0x54). So a shop row written two and a half
-- minutes LATER read as older, and the comparison always failed the same way:
-- towards the shop.
--
-- Measured on Wim Hof Method: subscription bought for the Stripe connection
-- (created 14:49:59.950Z), attached to the Shopify integration whose row was
-- written at 14:52:25. `datetime()` parses both formats and gets it right.
--
-- Only rows still keyed 'shopify:invoicexpress' are touched — anything already
-- moved by hand or by a checkout since 0044 is left alone — and only when the
-- account has a connection that is genuinely older. The last guard makes this
-- safe to run twice: it refuses to move a row onto a key that already exists,
-- which the composite primary key would reject anyway.
UPDATE subscriptions
   SET connection_key = (
         SELECT c.source_kind || ':' || c.destination_kind
           FROM connections c
          WHERE c.user_id = subscriptions.user_id
          ORDER BY datetime(c.created_at) ASC
          LIMIT 1),
       updated_at = CURRENT_TIMESTAMP
 WHERE connection_key = 'shopify:invoicexpress'
   AND EXISTS (SELECT 1 FROM connections c WHERE c.user_id = subscriptions.user_id)
   AND (
        NOT EXISTS (
          SELECT 1 FROM integrations i
           WHERE i.user_id = subscriptions.user_id
             AND i.shopify_domain IS NOT NULL AND i.shopify_domain <> '')
     OR (SELECT MIN(datetime(i.created_at)) FROM integrations i
          WHERE i.user_id = subscriptions.user_id
            AND i.shopify_domain IS NOT NULL AND i.shopify_domain <> '')
        > (SELECT MIN(datetime(c.created_at)) FROM connections c
            WHERE c.user_id = subscriptions.user_id)
   )
   AND NOT EXISTS (
        SELECT 1 FROM subscriptions s2
         WHERE s2.user_id = subscriptions.user_id
           AND s2.connection_key = (
                 SELECT c.source_kind || ':' || c.destination_kind
                   FROM connections c
                  WHERE c.user_id = subscriptions.user_id
                  ORDER BY datetime(c.created_at) ASC
                  LIMIT 1));
