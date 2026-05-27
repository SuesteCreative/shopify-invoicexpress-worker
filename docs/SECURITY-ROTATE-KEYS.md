# Rotation: ADMIN_API_KEY + NORMALIZE_SHOPIFY_ORDER_API_KEY

## Why

Both keys are presently in `wrangler.jsonc` under `vars` (plaintext, committed to git).

- `ADMIN_API_KEY=e3549eca4cb017439e609d674c2246da` — controls every `/admin/*` route (force-auth on flags, dev-mode tax override, manual backfill, etc.). Anyone with read access to this repo can call admin endpoints in prod.
- `NORMALIZE_SHOPIFY_ORDER_API_KEY=2b752911-eb5a-4659-b353-f07a53a3680d` — used to authenticate against the external Shopify normalizer (hstgr endpoint). Lower blast radius (read-only) but still in git history.

Both have been in git since the worker first deployed. Assume **compromised**.

## Steps (do in this order, do NOT skip)

### 1. Generate new keys

```sh
# 32-char random hex, suitable for both keys
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

Keep both values somewhere safe (1Password). You'll need them in step 4 (backoffice).

### 2. Push as Cloudflare secrets (NOT vars)

```sh
cd c:/Users/pedro/OneDrive/Github/Shopify-IX
npx wrangler secret put ADMIN_API_KEY            # paste value 1
npx wrangler secret put NORMALIZE_SHOPIFY_ORDER_API_KEY  # paste value 2
```

Verify:

```sh
npx wrangler secret list
```

Should show both names (values redacted).

### 3. Remove from `wrangler.jsonc`

Edit `wrangler.jsonc`, delete these two lines from the `vars` block:

```jsonc
"NORMALIZE_SHOPIFY_ORDER_API_KEY": "2b752911-eb5a-4659-b353-f07a53a3680d",
"ADMIN_API_KEY": "e3549eca4cb017439e609d674c2246da",
```

Commit + deploy:

```sh
git add wrangler.jsonc
git commit -m "chore(security): move ADMIN_API_KEY + normalizer key from vars to secrets"
npm run deploy:safe
```

### 4. Update the backoffice's env if it references either key

```sh
grep -rn "ADMIN_API_KEY\|NORMALIZE_SHOPIFY_ORDER_API_KEY" backoffice/
```

If `backoffice/.dev.vars` or Cloudflare Pages env vars hold the OLD values, replace with the NEW ones in:
- Cloudflare dashboard → Pages → rioko → Settings → Environment variables
- Local `backoffice/.dev.vars` (gitignored)

### 5. Smoke-test admin auth

```sh
# With OLD key — should now 401
curl -i -H "x-api-key: e3549eca4cb017439e609d674c2246da" \
  https://shopify-invoicexpress-worker.pedrotovarporto.workers.dev/admin/health

# With NEW key — should 200
curl -i -H "x-api-key: <new-admin-key>" \
  https://shopify-invoicexpress-worker.pedrotovarporto.workers.dev/admin/health
```

### 6. (Optional) Scrub git history

The old values are still recoverable from git history. For belt-and-braces:

```sh
# Identify commits that introduced them
git log -p --all -S"e3549eca4cb017439e609d674c2246da" -- wrangler.jsonc

# Use git-filter-repo or BFG to rewrite history
# THIS REWRITES HISTORY — coordinate with anyone else who has a clone
```

Not strictly necessary if the keys are rotated and Cloudflare API doesn't accept the old key anymore. Rewriting is a big operation; skip unless you have a specific reason (compliance, audit).

## Future: don't repeat this

Pre-deploy checklist (already added to `scripts/pre-deploy-backup.mjs`):

```sh
grep -E '"(ADMIN_API_KEY|.*SECRET|.*_KEY).*"\s*:\s*"[^"]+"' wrangler.jsonc \
  && echo "🛑 secret in vars block — stop" && exit 1
```

Add this guard before `wrangler deploy` runs.
