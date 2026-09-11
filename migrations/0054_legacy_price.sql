-- Which clients are on the old price, said once and read everywhere.
--
-- Two price points are live at the same time. The current plan is 7,50 €/month
-- or 75 €/year; a set of earlier clients pay 5 € and 50 €, and they keep those
-- for as long as they stay. Nothing recorded which was which, so every admin
-- surface either guessed from the Stripe price — when Stripe answered — or said
-- nothing at all, and "is this one legacy?" became a question somebody had to go
-- and look up per client.
--
-- NULL means "work it out": from the Stripe price when it resolves, and from the
-- amounts actually paid when it does not. 1 and 0 are a deliberate answer from
-- an operator and beat the derivation, the same way admin_override_at (0028)
-- beats the dates the webhook would otherwise write.
ALTER TABLE subscriptions ADD COLUMN legacy_price INTEGER;

-- The backfill reads what was actually charged, because that is the one thing
-- D1 holds for certain. The fleet's paid invoices fall into exactly six amounts
-- and they are unambiguous:
--
--    5,00 €  =  5 €/month, before the tax rate was applied   ┐
--    6,15 €  =  5 € + 23 %                                    ├ legacy
--   50,00 €  = 50 €/year, before the tax rate                 │
--   61,50 €  = 50 € + 23 %                                    ┘
--    9,23 €  = 7,50 € + 23 %   ┐ current
--   92,25 €  =   75 € + 23 %   ┘
--
-- (1,85 € is an extra seat, 1,50 € + 23 %, and says nothing about the plan.)
--
-- Scoped to the account rather than to one connection because `billing_events`
-- has no connection_key to scope by. An account running two pipes on different
-- plans gets both rows marked and an operator fixes the odd one with the toggle
-- — which is the whole point of the column being overridable.
UPDATE subscriptions
   SET legacy_price = 1
 WHERE user_id IN (
    SELECT DISTINCT user_id
      FROM billing_events
     WHERE type = 'invoice.paid'
       AND amount_cents IN (500, 615, 5000, 6150)
       AND user_id IS NOT NULL
 );
