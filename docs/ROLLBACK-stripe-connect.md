# Rollback — Stripe Connect → Moloni

The new integration (`source_kind = 'stripe_connect'`) shares code with the
Stripe → Moloni connections that already invoice real customers. Every new code
path is gated on a flag no existing connection sets, and the test suite pins
that. This page is for the morning when that is not reassuring enough.

**The rule: if a merchant on the existing Stripe → Moloni integration is
affected, stop first and diagnose afterwards.** Everything below is designed so
stopping costs nothing and is reversible.

---

## The commands

### Read-only — run these freely

| Command | What it tells you |
|---|---|
| `npm run stripe-connect:baseline` | **Run this before deploying.** Snapshots what every Stripe → Moloni merchant looks like right now, into a local `.stripe-connect-baseline.json`. |
| `npm run stripe-connect:check` | Compares the fleet against that snapshot. Exits non-zero only if something **moved**: a merchant who was invoicing has stopped, or an incident kind appeared that was not open before. |
| `npm run stripe-connect:status` | The above without a verdict, plus every `stripe_connect` connection and its state. |
| `npm run stripe-connect:rollback` | Prints the runbook below with your **real** Worker version id filled in. |
| `node scripts/stripe-connect-killswitch.mjs --off --dry-run` | Exactly which connections `--off` would pause. Changes nothing. |

Two decisions behind that check, both learned the hard way while building it:

**It reads `document_events`, not `incidents`.** The `incidents` table records
which *merchant* failed, not which of their *connections* did. The first version
of this check used it and reported 74 Lodgify failures against a merchant who
also happens to have a Stripe → Moloni connection — on day one, before anything
was deployed. `document_events` carries `source_kind` and `destination_kind`, so
it can answer the question that was actually asked.

**It is comparative.** This fleet always has something in flight somewhere. A
check that always complains is a check nobody reads, and that is exactly how the
"faturas por emitir" phantoms got ignored. The only question worth answering is
whether something changed when the new code went out, and that needs a before.

Connections that are not `active` (a draft, an inactive one) are listed for
context but cannot count as a regression: they were not invoicing before either.

### Changes production — guarded

| Command | What it does |
|---|---|
| `npm run stripe-connect:off` | Pauses every `stripe_connect` connection. **Seconds, no deploy.** |
| `npm run stripe-connect:on` | Puts each one back to the status it had before. |

Both refuse to run unless there is a real terminal **and** you type a phrase
(`PARAR STRIPE CONNECT` / `RETOMAR STRIPE CONNECT`). There is no `--force` and no
`--yes`. That is on purpose: this repo is worked on with AI agents, sometimes
several at once, and none of them should ever be able to make this decision.
They are also denied at the tool level in [.claude/settings.json](../.claude/settings.json),
along with `wrangler versions deploy` and `wrangler rollback`.

---

## The four levels, in order

### 1. Stop the new integration — seconds, no deploy

```
npm run stripe-connect:off
```

`UPDATE connections SET status='paused' WHERE ... source_kind='stripe_connect'`.
The worker only processes connections whose status is `active`, so this takes
effect on the very next event. The statement cannot match an existing customer's
row: their `source_kind` is `stripe`.

**Use this first.** It is the only step with no blast radius at all.

### 2. Roll the Worker back — about a minute

```
npx wrangler versions deploy <previous-version-id>@100
```

`npm run stripe-connect:rollback` prints this with the previous id already
filled in. This promotes a version that already exists: it does not rebuild, and
unlike a bare `wrangler deploy` from a laptop it **does not drop the Worker's
secrets**. Confirm afterwards with `npx wrangler deployments status`.

Cloudflare is UTC and git logs are Lisbon time. When the timestamps do not line
up, convert before concluding anything.

### 3. Roll the backoffice back — about a minute

Cloudflare dashboard → Pages → **rioko** → Deployments → the previous production
deployment → **Rollback to this deployment**. The Pages project promotes from
`main` on its own, so this only holds until the next merge — do step 4 if the
revert needs to stick.

### 4. Git — when the fire is out

```
git revert -m 1 <merge-commit-sha>
git push
```

Both the Worker and Pages rebuild from `main`. Note that Workers Builds
overwrites a manual deploy about 20 seconds after a merge, so do not hand-deploy
after pushing a revert; let CI do it and confirm with `deployments status`.

---

## Migration 0044 — leave it alone

It adds three nullable columns to `connections` (`oauth_state`,
`oauth_state_expires_at`, `last_token_refresh_at`). Nothing reads them unless the
new code runs, so they are inert after a rollback. Dropping a column rewrites the
whole table in SQLite, which is a far bigger risk than three unused columns.

Never run `wrangler d1 migrations apply` on `rioko-db`: the ledger is stuck at
0017 and it would replay everything since and die on duplicate columns.

---

## The order to do things in

```
npm run stripe-connect:baseline     # BEFORE the deploy
<deploy>
npm run stripe-connect:check        # after, and again the next morning
```

`--check` reports two kinds of regression, and only those:

- a merchant who was issuing documents in the last 24h at baseline and is now at
  zero;
- an incident kind now open for a merchant that was not open at baseline.

If it says nothing regressed, nothing regressed. If it flags something, step 1
above costs you nothing and buys you the time to look properly.

If the answer turns out to be "the existing merchants are fine and only the new
integration is broken", you do not need steps 2 to 4 at all — step 1 is the whole
fix.

---

## Before turning anything on

The new integration ships dark. It cannot run until **all** of these are true:

- `STRIPE_CONNECT_ENABLED = "1"` in `wrangler.jsonc` (currently `"0"`)
- `MOLONI_TOKEN_REFRESH_ENABLED = "1"` (currently `"0"`)
- `NEXT_PUBLIC_STRIPE_CONNECT_ENABLED = 1` in the Pages environment
- Secrets set: `STRIPE_PLATFORM_SECRET_KEY`, `STRIPE_CONNECT_WEBHOOK_SECRET`,
  and `STRIPE_CONNECT_CLIENT_ID` on the backoffice
- A Connect webhook endpoint registered in Stripe pointing at
  `/webhooks/stripe/connect`

With the flags at `0`, the route returns 404, the cron does not run, and the
wizard renders as locked. Deploying is therefore safe on its own — the risky
moment is flipping the flags, and step 1 above undoes that without a deploy.
