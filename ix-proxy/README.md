# rioko-ix-proxy

The InvoiceXpress proxy the worker talks to. Replaces `ix-proxy.kapta.app`,
whose source could not be found in any of our repositories, Cloudflare accounts
or backups.

## Why it was rebuilt

The old proxy validated request bodies against a closed schema and silently
dropped every field the schema did not name. That is how multi-currency was
lost: InvoiceXpress accepts `currency_code` + `rate` and prints a second
currency on the document, but the fields never reached it.

Measured against the IX sandbox, 2026-09-08:

| Path | `multicurrency` on the stored document |
|---|---|
| straight to InvoiceXpress | `{"rate":"1.718213","currency":"AUD","total":"99.999997"}` |
| through `ix-proxy.kapta.app` | `null` |
| through this proxy | `{"rate":"1.718213","currency":"AUD","total":"123.006869"}` |

So this one forwards the document body as given. It validates what it must —
the document type, the ids, the state — and stays out of the way of the rest,
because a field that vanishes without an error costs more than a bad request.

## What it does that InvoiceXpress does not

1. **Credentials in headers**, not in the query string, and the account name
   not in the hostname: `x-account-name`, `x-api-key`, `x-env: prod|dev`.
2. **One shape for every document type.** IX has a different endpoint and
   envelope per type; here it is `POST /v2/documents` with `{type, data}`.
3. **`?resolvers=on_tax_fallback_search_tax_by_value`** — rewrites a line whose
   `tax` is a bare number into the account's own tax with that value. Without
   it, IX reads `tax: 23` as "no known tax", applies the exempt one, and then
   refuses the document for having no exemption reason. A rate with no matching
   account tax is left alone so IX refuses it, which is correct: a shop selling
   at 20% into France must create that tax before it can invoice it.
4. **One envelope**: `{ data, success, error, metadata }` on every answer.

## Endpoints

`GET /v2/auth/check` · `GET /v2/taxes` · `GET /v2/sequence` ·
`POST /v2/documents` · `GET|PUT /v2/documents/{id}` ·
`GET /v2/documents/{id}/related` · `GET /v2/documents/{id}/link` ·
`POST /v2/documents/{id}/email` · `POST /v2/documents/reference` ·
`POST /v2/credit_notes` · `POST /v2/change_state` · `GET /v2/meta/error-codes`

`GET /openapi.json` serves the spec; the worker's IX client is generated from
it (`generate.ts` in the repo root).

## Deploy

```
cd ix-proxy
npm install
npx wrangler deploy
```

Then attach the domain once, in the dashboard: Workers → `rioko-ix-proxy` →
Settings → Domains & Routes → Add custom domain → `ix.rioko.online`. The
`rioko.online` zone is in this Cloudflare account, so Cloudflare writes the DNS
record itself.

It holds no secrets: the account name and API key travel per request, because
one worker serves every merchant.

## Cutover, and how to undo it

The worker reads `IX_PROXY_URL` (see `src/api/ix/base-url.ts`). Absent, it keeps
talking to `ix-proxy.kapta.app` — so deploying this changes nothing until the
var is set.

```jsonc
// wrangler.jsonc, worker vars
"IX_PROXY_URL": "https://ix.rioko.online"
```

**Rollback is putting the old URL back**, or removing the var. No code deploy.

Cut over one merchant's traffic first, out of hours, and check three things on
the next document: the total matches the payment, the exemption code is the one
that was sent, and — for a foreign-currency sale — `multicurrency` is present.

## Parity notes

- `POST /v2/documents/reference` answers `404 DOCUMENT_NOT_FOUND` for a draft,
  same as the old proxy: IX's text search does not return drafts. The worker's
  own lookup refuses to run outside production anyway.
- Errors keep InvoiceXpress's own wording, in Portuguese, under
  `error.message` — the worker classifies on that text.
- Unlike the old proxy, `simplified_invoice` and `debit_note` are accepted.
