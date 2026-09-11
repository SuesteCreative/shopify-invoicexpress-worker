-- What a new client told us on the way in.
--
-- 1. The privacy policy. `privacy_policy_accepted` has always been a 0/1 flag,
--    which answers "did they agree" but not "to which version, and when" —
--    the only two things worth having when someone asks. The date is stamped
--    the FIRST time the box is ticked and never moved by a later edit of the
--    same profile: a consent that re-dates itself every time the merchant
--    fixes their address is not a record of anything.
--
-- 2. The pair of platforms picked in the general onboarding, before any
--    connection exists. It is an intention, not a connection: no credentials,
--    no authorisation, nothing the worker reads. It is here so support can see
--    what the client came to do when they stop halfway, and so the onboarding
--    can put them back where they left off.
ALTER TABLE users ADD COLUMN privacy_policy_accepted_at TEXT;
ALTER TABLE users ADD COLUMN onboarding_source_kind TEXT;
ALTER TABLE users ADD COLUMN onboarding_destination_kind TEXT;
