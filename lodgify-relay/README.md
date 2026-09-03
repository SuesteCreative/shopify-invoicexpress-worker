# Lodgify egress relay

The fixed IPv4 that Lodgify allowlists. Every Lodgify call the platform makes
leaves through here.

## Why

Lodgify blocked our egress on 2026-08-02: *"This IP address has been blocked…
flagged as an unregistered API user requesting data for multiple Lodgify end
users."* Cloudflare Workers have no stable egress IP, and Lodgify support
confirmed in writing on 2026-08-18 that they can allowlist **by IP address
only** — not by API key, not by account. So the calls have to leave from one
address, and this app is that address.

This is a tourniquet, not a cure. The *"limit at the moment is 20 connected
users"* comes from being an unregistered third-party provider (Lodgify's own
docs say to contact their partnership team). A fixed IP buys a stable identity,
not headroom. Partner registration is the actual remedy; when it lands, delete
this app.

**Do not** rotate the egress address or change identifiers to work around a
block. It would risk the merchants' API keys and be re-blocked on the first
pattern match.

## Current state (2026-09-03)

| | |
|---|---|
| Fly app | `rioko-lodgify-relay`, org `bruno-22` (Bruno's, holds the credits) |
| Region | `cdg`, two 256 MB machines |
| Hostname | `rioko-lodgify-relay.fly.dev` |
| **Egress IPv4** | **`209.71.70.77`** ← the address Lodgify must allowlist |
| Egress IPv6 | `2a09:8280:e607:1:0:182:6a95:0` (unused: the Caddyfile forces IPv4) |

Verified from inside a machine: egress is `209.71.70.77`, it survived a redeploy
onto new machines (app-scoped, as intended), and a real merchant key against
`/v1/reservation` returned **200** — the same call returns a 429 block from the
Worker's own egress. The relay's own contract checks out too (403 without the
secret, 404 off the allowlist, `x-rioko-gateway-error` set).

Not done yet: Lodgify has not been told the address. Send it only once the
Worker's traffic actually leaves through here — allowlisting an address that
carries no traffic proves nothing and muddies the support thread.

## Layout

| File | What it is |
|---|---|
| `Caddyfile` | The whole proxy: shared secret, path allowlist, IPv4-only upstream, header scrubbing, `/healthz` |
| `entrypoint.sh` | Fail-closed guard — refuses to start without a ≥32-char secret |
| `Dockerfile` | Standard `caddy:2-alpine`, no plugins |
| `fly.toml` | Two 256 MB machines in `cdg`, sharing one app-scoped egress IP |

The Worker half lives in `src/services/lodgify-api.ts`. The path allowlist here
must stay in step with `LODGIFY_ALLOWED_PATH_PREFIXES` there; a path added there
and not here fails closed with a 404 rather than escaping to a direct call.

## Deploy

```bash
# 1. Create the app in the org that holds the credits (NOT Personal).
fly apps create rioko-lodgify-relay --org <org-slug>

# 2. The shared secret. Generate it, set it, never print it again.
fly secrets set GW_KEY_A="$(openssl rand -hex 32)" --app rioko-lodgify-relay

# 3. Ship it.
fly deploy --app rioko-lodgify-relay

# 4. The static egress IPv4. THIS is the billable step ($3.60/mo).
fly ips allocate-egress --app rioko-lodgify-relay -r cdg
```

## Verify before telling Lodgify anything

The address only counts if Lodgify actually sees it. In order:

```bash
# a. What the machine's egress really is. Must be the allocated IPv4, and the
#    v6 line must be empty — see the IPv4-only note in the Caddyfile.
fly ssh console --app rioko-lodgify-relay -C "curl -s4 https://ifconfig.me"
fly ssh console --app rioko-lodgify-relay -C "curl -s6 --max-time 5 https://ifconfig.me || true"

# b. The decisive test: does Lodgify accept that address? Use a real merchant
#    key. A 429 carrying "This IP address has been blocked" means the new
#    address inherited the block or the range is flagged — raise that with
#    Lodgify support before going further, and do not rotate.
fly ssh console --app rioko-lodgify-relay -C \
  "curl -s4 -o /dev/null -w '%{http_code}\n' -H 'X-ApiKey: <key>' \
   'https://api.lodgify.com/v1/reservation?offset=0&limit=1&trash=False'"

# c. The relay's own contract, from your workstation.
curl -s -o /dev/null -w '%{http_code}\n' https://rioko-lodgify-relay.fly.dev/healthz   # 200
curl -s -o /dev/null -w '%{http_code}\n' https://rioko-lodgify-relay.fly.dev/v1/reservation  # 403, no secret
curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Rioko-Gateway-Key: wrong' \
  https://rioko-lodgify-relay.fly.dev/v1/reservation                                    # 403
curl -s -o /dev/null -w '%{http_code}\n' -H "X-Rioko-Gateway-Key: $KEY" \
  https://rioko-lodgify-relay.fly.dev/v1/properties                                     # 404, never reaches Lodgify

# A disallowed METHOD also 404s rather than 405: the allowlist matcher requires
# method AND path together, so a PATCH falls through to the catch-all. What
# matters holds either way — it never reaches Lodgify.
curl -s -o /dev/null -w '%{http_code}\n' -X PATCH -H "X-Rioko-Gateway-Key: $KEY" \
  https://rioko-lodgify-relay.fly.dev/v1/reservation                                    # 404

# d. Nothing sensitive reached the logs.
fly logs --app rioko-lodgify-relay | grep -ci "X-ApiKey\|Gateway-Key"   # 0
```

Only after (b) returns 200: send Lodgify the IPv4 and the app hostname, then set
`LODGIFY_GATEWAY_URL` + `LODGIFY_EGRESS_MODE="gateway"` on the Worker.

## Rotating the secret, without an outage

The Caddyfile accepts two values. `GW_KEY_B` defaults to `GW_KEY_A`, so the
normal state is one live key.

```bash
fly secrets set GW_KEY_B="$(openssl rand -hex 32)" --app rioko-lodgify-relay
# then: wrangler secret put LODGIFY_GATEWAY_KEY   (the new B)
fly secrets set GW_KEY_A="<the new B>" --app rioko-lodgify-relay
fly secrets unset GW_KEY_B --app rioko-lodgify-relay
```

Rotate on any change of access to the Cloudflare or Fly account.

## This is a new single point of failure

Say so plainly: if this app is down, no Lodgify booking gets invoiced. Two
machines and a 30-second health check cover a machine failure; they do not cover
a Fly platform outage or a billing lapse. Mitigations that belong with it:

- the Worker probes `/healthz` on its 30-minute cron and raises a critical
  incident naming the relay, rather than waiting for the 08:00 digest to notice
  stale ingestion;
- rollback is one variable: set `LODGIFY_EGRESS_MODE="direct"` on the Worker and
  deploy. Behaviour returns to today's — blocked, but no new failure mode.

## GDPR

Guest names, postal addresses, emails and phone numbers transit this app
(`fetchGuestDetails`). Fly.io Inc becomes a subprocessor for two paying clients'
guest data: sign their DPA, add them to the merchant-facing subprocessor list,
and tell Origos and Overbuilding. Region is pinned to `cdg` so the data stays in
the EU. If an EU-only processor is required instead, the same four files run on
any small VPS — only `fly.toml` is Fly-specific.
