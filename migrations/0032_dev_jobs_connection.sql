-- dev_jobs: record WHICH connection a recovery job acted on.
--
-- Until now a job row carried only `type` ("reemit", "stripe_reemit", …), so the
-- connection was encoded in a string prefix that had to be invented per source.
-- With one generic engine serving every (source × destination) pair, the pair
-- belongs in columns: the dev-mode panel filters the job log by the connection
-- the operator has selected, and "which destination did this credit note go to?"
-- stops being a question you answer by reading the summary JSON.
--
-- Both nullable: every existing row predates this and is Shopify→InvoiceXpress
-- by construction, but backfilling that assumption into the data would make a
-- guess indistinguishable from a fact.
ALTER TABLE dev_jobs ADD COLUMN source_kind TEXT;
ALTER TABLE dev_jobs ADD COLUMN destination_kind TEXT;

-- The dev-mode log reads "this user's most recent jobs" on every panel load.
CREATE INDEX IF NOT EXISTS idx_dev_jobs_user_started ON dev_jobs(user_id, started_at DESC);
