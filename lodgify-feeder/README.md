# lodgify-feeder

Fetches Lodgify bookings from a network Lodgify has not blocked, and posts them
to the Rioko worker.

## Why this exists

Since 2026-08-02 Lodgify returns 429 to the Cloudflare Worker's egress:

> This IP address has been blocked from making further requests to the Lodgify
> API. You've been flagged as an **unregistered API user requesting data for
> multiple Lodgify end users**. Please fill the form in
> https://www.lodgify.com/partners to register.

It is a block on *behaviour*, not a rate limit — the same API keys return 200
from an ordinary network in under 250 ms. It is not fixable in code, and
rotating egress IPs to get around it would be evading a provider's access
control, would put the merchants' own API keys at risk, and would be re-blocked
on the first pattern match. **Do not do that.**

So: one stable, identified egress (this project), an hourly cadence, and the
partner registration submitted in parallel. **When partner registration lands,
delete this project** — the Worker polls Lodgify directly again, and gets
webhooks on top.

## What it does NOT do

No fiscal logic. It does not decide whether a booking is paid, whether it is
inside the cutoff, or what a document should say. It fetches raw v1 items and
hands them to `POST /admin/lodgify/poll`, which runs the same normalization,
settlement gate, dedup and emission the cron always ran. Keep it that way: a
second implementation of "is this booking billable" is how the two silently
start disagreeing.

## Run shape

Per tenant, per hour:

1. `GET /v1/reservation` (offset paging) — the whole list.
2. `POST /admin/lodgify/poll {user_id, bookings, dry_run:true}` — refreshes the
   D1 mirror, bills nothing, answers with `wouldInvoice[]`.
3. `GET /v1/reservation/booking/{id}` for **only** those bookings (≤25/run), and
   merge the address + `note` (the NIF) into the item.
4. `POST /admin/lodgify/poll {user_id, bookings}` — the real run.

~25-35 Lodgify requests/hour for the whole fleet. Enriching every booking on
every run would be tens of thousands a day from one IP serving several accounts,
which is precisely the behaviour that got the integration blocked.

## Environment

| var | what |
|---|---|
| `WORKER_URL` | `https://shopify-invoicexpress-worker.pedrotovarporto.workers.dev` |
| `ADMIN_API_KEY` | worker admin key, sent as `x-api-key` |
| `CRON_SECRET` | Vercel injects `Authorization: Bearer $CRON_SECRET` on cron runs; without this check the endpoint is a public "invoice everyone" button |
| `FEED_ENABLED` | `0` disables without a redeploy |
| `FEED_USER_AGENT` | identifies us to Lodgify; keep the partner-application URL in it |

API keys are **not** stored here. They come from
`GET /admin/lodgify/feed-manifest`, so D1 stays the single source of truth and
onboarding a merchant needs no deploy. Never log the manifest response.

## Vercel project

Separate project, **Root Directory = `lodgify-feeder`**, Framework Preset
"Other", Node 22. Ignored Build Step: `git diff --quiet HEAD^ HEAD -- .`.
Cron `7 * * * *` (offset minute, so it never collides with the Worker's crons).

## Manual invocation

```bash
curl -H "Authorization: Bearer $CRON_SECRET" "$FEEDER_URL/api/feed?mode=diag"
curl -H "Authorization: Bearer $CRON_SECRET" "$FEEDER_URL/api/feed?tenant=user_...&dry=1"
curl -H "Authorization: Bearer $CRON_SECRET" "$FEEDER_URL/api/feed?tenant=user_..."
```

`mode=diag` probes reachability per key from this egress — the only way to know
whether Vercel is clean, and the API-key validation the onboarding wizard never
does.

## Guard rails worth knowing before you change anything

- **Never POST `bookings: []`.** An empty array reads to the Worker as "this
  account has no bookings": the mirror goes untouched, nothing bills, nothing
  complains. A failed fetch aborts the tenant instead. The Worker now 400s on an
  empty array as a second line of defence.
- **Never POST a short list.** A failure on any page aborts the whole tenant —
  a partial list would be mirrored as the truth.
- **A tenant with no `invoice_cutoff` is refused.** A NULL cutoff means "invoice
  everything", which on a first run bills a merchant's entire history, dated
  today, unattended. History gets billed by
  `POST /admin/connection/backfill {ignore_cutoff:true}`, deliberately, in
  tranches, with the client's accountant informed.
- **Failures must be loud.** Any tenant failure reports to
  `POST /admin/lodgify/feed-error` (the Worker raises the same incident it would
  raise itself) *and* returns HTTP 500 so Vercel's cron-failure notification
  fires — a channel that survives the Worker being down.
- **If this stops running, the Worker notices**: the 08:00 sweep pages when a
  connection has had no completed ingestion for 6h.
