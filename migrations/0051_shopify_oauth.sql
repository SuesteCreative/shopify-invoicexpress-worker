-- Shopify OAuth with the callback on our own domain ("Método 2" in the
-- onboarding helper). Every column is additive and NULL for the integrations
-- already in production: nothing here changes an existing row, and no store on
-- the manual flow is affected by any of it.
--
-- Why the app credentials have to be stored at all: the manual flow sends the
-- merchant to `https://example.com/` and the authorisation code dies in their
-- address bar, so the client secret never reaches us and a webhook created
-- through the Admin API — signed with that very secret — could never be
-- verified. That is the whole of the 2026-05-21 failure recorded in
-- backoffice/src/app/api/integrations/activate/route.ts. With the callback on
-- rioko.online we hold the secret, so `shopify_webhook_secret` can simply carry
-- it and the worker verifies app-owned deliveries with no change at all.
--
-- oauth_state / oauth_state_expires_at hold the one-shot CSRF nonce while the
-- merchant is away on Shopify's consent screen. Same reasoning as migration
-- 0047 for connections: the Worker/Pages pair has no session store, so the
-- nonce lives on the row it authorises and is cleared when the code is
-- exchanged. It sits on `integrations` rather than `connections` because the
-- legacy Shopify->InvoiceXpress pipe is a set of columns on that table and has
-- no `connections` row of its own.
--
-- The state is also the ONLY link between the callback and an account: whoever
-- presses Install is signed in to Shopify, not necessarily to Clerk, so the
-- callback cannot resolve a user from the session.
ALTER TABLE integrations ADD COLUMN shopify_client_id TEXT;
ALTER TABLE integrations ADD COLUMN shopify_client_secret TEXT;
ALTER TABLE integrations ADD COLUMN shopify_oauth_state TEXT;
ALTER TABLE integrations ADD COLUMN shopify_oauth_state_expires_at TEXT;
