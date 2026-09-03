# Lodgify static-IP relay — runbook

> ## ESTADO: HISTÓRICO. Não seguir como instruções.
>
> Desenhado a 2026-08-18, **executado a 2026-09-03** — mas noutra máquina. O que
> está a correr em produção é um relay Caddy na **Fly.io** (`rioko-lodgify-relay`,
> IPv4 fixo `209.71.70.77`), não o VPS Hetzner que a secção 2 descreve. A Fly foi
> escolhida porque o IP de saída lá é *app-scoped*: substituir a máquina não perde
> o endereço que a Lodgify autorizou, e não há SSH, fail2ban, ACME nem sistema
> operativo para manter.
>
> **Para operar o que existe hoje: [`lodgify-relay/README.md`](../lodgify-relay/README.md).**
>
> Este ficheiro fica no repo por uma razão só: a **secção 3**, a revisão
> adversarial. Atacou as duas primeiras secções e encontrou 22 defeitos reais,
> cinco deles críticos, e é por causa dela que o corte correu bem. Todos os
> críticos foram corrigidos nos PR #33 e #35: a chave de API de cada cliente
> devolvida em texto limpo pelo `feed-manifest`, o backoffice a chamar a Lodgify
> a partir do Pages, o feeder da Vercel como segundo IP não autorizado, o
> fallback silencioso para saída directa, e o segredo a poder acabar no git.
>
> **Continuam em aberto, por decisão:** o achado 13 (teto dos 20 clientes ligados
> — hoje há 3, portanto a guarda é prematura), o achado 14 (ritmo global das
> chamadas concentrado no relay — mesma razão) e o achado 19 (RGPD, agora em
> [`subprocessadores.md`](subprocessadores.md)).
>
> As secções 1 e 2 abaixo descrevem, respectivamente, uma alteração ao worker que
> foi feita de outra forma e uma máquina que nunca existiu. Ficam pelo contexto
> que dão à revisão, não para serem executadas.

Lodgify support (Matthew Turner) confirmed in writing that they can allowlist by
IP address only — not by API key, not by account — and that the current cap is
20 connected users. Cloudflare Workers have no stable egress IP, so every
Lodgify call has to leave through one small VPS with a static IPv4.

Origos and Overbuilding have had zero booking sync since 2026-08-02.

Three sections below: the Worker code change, the VPS build, and an adversarial
review of both. **Read section 3 first** — it found real defects in the other two.

---

## 1. Worker code change

# Lodgify egress-gateway routing — implementation spec

Verified against the working tree at `c:\dev\shopifyix` (branch `feat/document-log`). Every line number below was read from the current files.

---

## 0. Inventory — what actually calls Lodgify (6 sites, not 5)

| # | File:line | Call | env in scope? |
|---|---|---|---|
| 1 | `src/adapters/sources/lodgify-source.ts:121` | `GET /v2/reservations/{id}` | ❌ (adapter has only `ctx`) |
| 2 | `src/adapters/sources/lodgify-source.ts:472` | `GET /v1/reservation/booking/{id}` (`fetchGuestDetails`) | ❌ (nested helper) |
| 3 | `src/handlers/reconciliation.ts:284/287` | `GET /v1/reservation?offset=…` (bootstrap) | ✅ `liveFetchLodgifyBookings(env, …)` |
| 4 | `src/index.ts:777` → fetches at `791`, `802`, `818` | `/webhooks/v1/list`, `/webhooks/v1/unsubscribe/{id}`, `/webhooks/v1/subscribe` | ✅ `c.env` |
| 5 | `src/index.ts:2706` → fetch at `2746/2750` | `GET /v1/reservation?offset=…` (the 30-min poll) | ⚠️ `listLodgifyBookings(apiKey)` takes no env — caller `index.ts:3130` has it |
| 6 | **`src/index.ts:1206-1207`** (`/admin/lodgify/diag`) | v1 + v2 probes via `LODGIFY_API` | ✅ `c.env` |

Site 6 was not in the brief. It shares the `LODGIFY_API` constant with site 5, so deleting that constant without touching it breaks the build.

Two more places reach Lodgify but are **not** Worker code — see §5.

---

## 1. New module: `src/services/lodgify-api.ts`

Path chosen to sit beside the existing `src/services/lodgify-amounts.ts` and `src/services/lodgify-booking.ts`, and to mirror the established per-vendor transport wrapper `src/services/stripe.ts` (`stripeFetch(path, key, opts)` → raw `Response`, callers own status handling). Same shape, same contract.

```ts
// src/services/lodgify-api.ts
import type { Env } from "../env";

/**
 * Every outbound call to Lodgify leaves through here.
 *
 * WHY: on 2026-08-02 Lodgify blocked this Worker's egress — "flagged as an
 * unregistered API user requesting data for multiple Lodgify end users". Their
 * support confirmed in writing that they can allowlist an IP address and
 * NOTHING else: not an API key, not an account. Cloudflare Workers have no
 * stable egress IP, so the calls are relayed through one small VPS with a
 * static IPv4 that Lodgify has allowlisted.
 *
 * This is a transport swap and nothing more: same paths, same per-merchant
 * `X-ApiKey`, same bodies, same status codes. It exists so the whole fleet
 * leaves from one address.
 *
 * There is deliberately NO per-call opt-out. A Lodgify call that does not go
 * through here is a call that reproduces the outage, so the only way to reach
 * Lodgify from the Worker is `lodgifyFetch`.
 */

/** Where Lodgify actually lives. Used when no relay is configured. */
export const LODGIFY_DIRECT_BASE = "https://api.lodgify.com";

/**
 * Header carrying the relay's shared secret.
 *
 * MUST NOT be any casing of `x-api-key`. HTTP header names are
 * case-insensitive, and the MERCHANT's Lodgify credential rides on the very
 * same request as `X-ApiKey`. `X-Api-Key` and `X-ApiKey` are the same header —
 * naming the relay secret that way would overwrite each merchant's Lodgify key
 * with our shared secret and every call would 401 with an error that points
 * nowhere near the cause. The repo's own `ADMIN_API_KEY` uses `x-api-key`,
 * which is exactly the name that must be avoided here.
 */
export const LODGIFY_GATEWAY_HEADER = "X-Rioko-Gateway-Key";

/** Set by the relay on failures IT produced (upstream unreachable, bad secret,
 *  path not allowlisted). Lets the Worker tell "our VPS is down" apart from
 *  "Lodgify is down" — they are different incidents with different remedies. */
export const LODGIFY_GATEWAY_ERROR_HEADER = "x-rioko-gateway-error";

export interface LodgifyGateway {
  /** Origin (+ optional path prefix) every Lodgify path hangs off. No trailing slash. */
  readonly base: string;
  /** True when traffic is relayed; false = straight to api.lodgify.com. */
  readonly relayed: boolean;
  /** Shared secret for the relay. Absent when direct. */
  readonly secret?: string;
  /**
   * Set when the env vars are present but unusable. Carried rather than thrown
   * so a typo in a LODGIFY_* variable cannot take down Shopify and Stripe
   * invoicing: `buildAdapterCtx` resolves this for every source, and the blast
   * radius of a bad value has to stop at the calls that actually touch Lodgify.
   * `lodgifyFetch` refuses on it.
   */
  readonly configError?: string;
}

/**
 * Resolve the gateway from env. Pure, cheap, no I/O — safe to call per request.
 *
 * Unset LODGIFY_GATEWAY_URL => the exact behaviour that shipped before the relay
 * existed. The whole change is therefore inert until the variable is set, which
 * is what lets it be merged and deployed BEFORE the VPS exists, and rolled back
 * by clearing one variable rather than by reverting code.
 */
export function resolveLodgifyGateway(
  env: Pick<Env, "LODGIFY_GATEWAY_URL" | "LODGIFY_GATEWAY_KEY">,
): LodgifyGateway {
  const raw = (env.LODGIFY_GATEWAY_URL ?? "").trim();
  if (!raw) return { base: LODGIFY_DIRECT_BASE, relayed: false };

  let base: string;
  try {
    const u = new URL(raw);
    // Merchant Lodgify keys travel on this hop. Plaintext is not an option.
    if (u.protocol !== "https:") throw new Error(`must be https, got "${u.protocol}"`);
    base = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch (e: any) {
    return {
      base: LODGIFY_DIRECT_BASE,
      relayed: false,
      configError: `LODGIFY_GATEWAY_URL is set but unusable ("${raw}"): ${e?.message ?? e}`,
    };
  }

  const secret = (env.LODGIFY_GATEWAY_KEY ?? "").trim();
  if (!secret) {
    // The relay refuses unauthenticated callers, so this would 401 every call.
    // Say which variable is missing, here, instead of shipping a mystery 401.
    return { base, relayed: true, configError: "LODGIFY_GATEWAY_URL is set but LODGIFY_GATEWAY_KEY is empty" };
  }
  return { base, relayed: true, secret };
}

export interface LodgifyFetchOpts {
  method?: string;
  /** Per-call headers. The MERCHANT's `X-ApiKey` belongs here. */
  headers?: Record<string, string>;
  body?: BodyInit | null;
  signal?: AbortSignal | null;
}

/**
 * Fetch a Lodgify path. `path` is absolute-from-root and carries its own query
 * string, e.g. "/v1/reservation?offset=0&limit=50".
 *
 * The relay secret is applied LAST and under its own name, so a caller's
 * `X-ApiKey` is copied through untouched — that credential belongs to the
 * merchant and is the only thing Lodgify authenticates on.
 */
export function lodgifyFetch(
  gw: LodgifyGateway,
  path: string,
  opts: LodgifyFetchOpts = {},
): Promise<Response> {
  // A misconfigured relay must NEVER silently fall back to direct: that is the
  // outage this module exists to end, and it would come back invisibly.
  if (gw.configError) return Promise.reject(new Error(`LODGIFY_GATEWAY_MISCONFIGURED: ${gw.configError}`));
  if (!path.startsWith("/")) {
    return Promise.reject(new Error(`lodgifyFetch: path must start with "/" (got "${path}")`));
  }

  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (gw.relayed && gw.secret) headers[LODGIFY_GATEWAY_HEADER] = gw.secret;

  return fetch(`${gw.base}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body ?? undefined,
    signal: opts.signal ?? undefined,
  });
}

/** True when this response is the RELAY failing, not Lodgify. */
export function isGatewayFailure(gw: LodgifyGateway, res: Response): boolean {
  return gw.relayed && res.headers.get(LODGIFY_GATEWAY_ERROR_HEADER) != null;
}
```

### Contract the relay must honour (Worker-side assumptions)

The Worker code above only works if the VPS does these things — state them in the runbook:

1. Forwards `{METHOD} {path}` verbatim to `https://api.lodgify.com{path}`, rewriting `Host:` to `api.lodgify.com`.
2. Copies every request header through **except** `X-Rioko-Gateway-Key` (strip it; never forward our secret to Lodgify) and `Host`.
3. Returns Lodgify's status, body and headers unmodified — including `Retry-After`, which the existing 429 backoff at `index.ts:2778` and `reconciliation.ts` read.
4. On any failure it produced itself, answers with `X-Rioko-Gateway-Error: <short reason>`.
5. Rejects requests without a valid `X-Rioko-Gateway-Key` (constant-time compare) **and** whose path is outside the allowlist `^/v1/reservation`, `^/v2/reservations/`, `^/webhooks/v1/` — the two guards together are what stop it being an open relay.
6. Never logs request headers (merchant Lodgify keys are in them).

---

## 2. `AdapterCtx` gets the gateway — and it is REQUIRED

`src/adapters/sources/lodgify-source.ts` has no `env`: `SourceAdapter.toNormalized(parsedBody, ctx)` is a fixed interface. The seam is `buildAdapterCtx(env, …)` (`src/services/adapter-ctx.ts:32`), which is already the single documented way to build a ctx.

**`src/adapters/types.ts` — insert after line 35 (`viesChecker?`), before the closing `}` at line 36:**

```ts
  /**
   * How to reach Lodgify. Required, not optional, and that is the whole point:
   * an optional field reads as `undefined` at a hand-rolled call site, the
   * adapter falls back to direct, and the IP block silently returns with no
   * compiler complaint. Required means every ctx construction site must decide,
   * and `npm run build` names the ones that didn't.
   *
   * Harmless for non-Lodgify sources — `resolveLodgifyGateway` is pure.
   */
  lodgify: LodgifyGateway;
```

Add at the top of `src/adapters/types.ts`:
```ts
import type { LodgifyGateway } from "../services/lodgify-api";
```

**`src/services/adapter-ctx.ts` — add to the returned ctx (after line 64, `viesChecker,`):**
```ts
      lodgify: resolveLodgifyGateway(env),
```
plus `import { resolveLodgifyGateway } from "./lodgify-api";` at the top.

### Compile-time fallout, all of it

- `src/handlers/generic-pipeline.ts:337` — the `runPipelineCore` parameter is a **structural literal** that omits the extra ctx fields, so `sourceAdapter.toNormalized(body, ctx)` (lines 356, 619, 669) stops type-checking. Fix by widening it:

```ts
// before (line 337)
  ctx: { apiKey: string; config: IRequestConfig; sourceConfig?: Record<string, any>; destinationConfig?: Record<string, any> },
// after
  ctx: AdapterCtx,
```
with `import type { AdapterCtx } from "../adapters/types";` added to the import block (lines 1-17). Runtime is unchanged — the object passed in already comes from `buildAdapterCtx`. `applyTagRoute` (`src/services/tag-routing.ts:165-204`) spreads `...ctx` in all three branches, so the field survives re-routing.

- `src/handlers/reconciliation.ts:505` and `:730` — `const ctxLike = { … } as AdapterCtx;`. **No change needed**: a `as` assertion tolerates missing properties, and both are destination-only (IX/Moloni document reads) and never call Lodgify.

- **`src/index.ts:2829` — `let ctx: any = {` in `emitLodgifyPartialInvoice`. This one is `any`, so the compiler will NOT catch it, and it is a genuine Lodgify path** (`toNormalized` at line 2852 reaches `fetchGuestDetails` whenever the preloaded item has `_enriched: false`). Two edits:

```ts
// before (2829-2835)
  let ctx: any = {
    apiKey: env.NORMALIZE_SHOPIFY_ORDER_API_KEY,
    config: o.config,
    sourceConfig: o.sourceCfg,
    destinationConfig: o.destinationConfig,
    productMappings: o.productMappings,
  };
// after
  // Typed, not `any`: this is a Lodgify path (toNormalized → fetchGuestDetails),
  // and `any` is what would let it silently keep leaving from the blocked IP.
  let ctx: AdapterCtx = {
    apiKey: env.NORMALIZE_SHOPIFY_ORDER_API_KEY,
    config: o.config,
    sourceConfig: o.sourceCfg,
    destinationConfig: o.destinationConfig,
    productMappings: o.productMappings,
    lodgify: resolveLodgifyGateway(env),
  };
```
(`ctx.config?.auto_finalize` at line 2887 keeps working; `AdapterCtx.config` is non-optional so drop the `?.` or leave it, either compiles.)

---

## 3. Per-call-site edits

### 3.1 `src/adapters/sources/lodgify-source.ts`

Add to imports (after line 4):
```ts
import { lodgifyFetch, type LodgifyGateway } from "../../services/lodgify-api";
```

**Line 16** (doc comment):
```
 * Full booking fetched via GET https://api.lodgify.com/v2/reservations/{id}
→
 * Full booking fetched via GET /v2/reservations/{id} through the Lodgify
 * gateway (services/lodgify-api.ts — Lodgify allowlists one static IP).
```

**Line 121:**
```ts
// before
      const res = await fetch(`https://api.lodgify.com/v2/reservations/${bookingId}`, {
        headers: { "X-ApiKey": apiKey, "Accept": "application/json" },
      });
// after
      const res = await lodgifyFetch(ctx.lodgify, `/v2/reservations/${bookingId}`, {
        headers: { "X-ApiKey": apiKey, "Accept": "application/json" },
      });
```

**Line 208:**
```ts
// before
    const enriched = booking._enriched ? null : await fetchGuestDetails(bookingId, apiKey);
// after
    const enriched = booking._enriched ? null : await fetchGuestDetails(ctx.lodgify, bookingId, apiKey);
```

**Line 470 (signature) + 472 (fetch):**
```ts
// before
async function fetchGuestDetails(bookingId: string, apiKey: string): Promise<GuestDetails | null> {
  try {
    const res = await fetch(`https://api.lodgify.com/v1/reservation/booking/${bookingId}`, {
      headers: { "X-ApiKey": apiKey, "Accept": "application/json" },
    });
// after
async function fetchGuestDetails(gw: LodgifyGateway, bookingId: string, apiKey: string): Promise<GuestDetails | null> {
  try {
    const res = await lodgifyFetch(gw, `/v1/reservation/booking/${bookingId}`, {
      headers: { "X-ApiKey": apiKey, "Accept": "application/json" },
    });
```

**Line ~505 (the existing `catch { return null; }`)** — add one line, because this catch would otherwise swallow a `LODGIFY_GATEWAY_MISCONFIGURED` and every Moloni customer would quietly be created without an address (the exact failure `src/services/lodgify-booking.test.ts` was written to guard):
```ts
  } catch (e: any) {
    // Non-fatal: enrichment is additive; invoice still issues without it.
    // Logged because a MISCONFIGURED gateway lands here too, and a silent
    // address-less customer is how that would otherwise present.
    console.warn(`[Lodgify] guest enrichment for ${bookingId} failed: ${e?.message ?? e}`);
    return null;
  }
```

### 3.2 `src/handlers/reconciliation.ts`

Import (after line 10):
```ts
import { resolveLodgifyGateway, lodgifyFetch } from "../services/lodgify-api";
```

**Lines 282-287:**
```ts
// before
  const headers = { "X-ApiKey": apiKey, "Accept": "application/json" };
  for (let page = 0; page < 40; page++) {
    const url = `https://api.lodgify.com/v1/reservation?offset=${page * limit}&limit=${limit}&trash=False`;
    let pageItems: any[] | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(url, { headers });
// after
  const gw = resolveLodgifyGateway(env);
  const headers = { "X-ApiKey": apiKey, "Accept": "application/json" };
  for (let page = 0; page < 40; page++) {
    const path = `/v1/reservation?offset=${page * limit}&limit=${limit}&trash=False`;
    let pageItems: any[] | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await lodgifyFetch(gw, path, { headers });
```

Additionally wrap the `for (let page …)` loop (283-317) in `try { … } catch (e: any) { console.error("[Recon] Lodgify live bootstrap failed:", e?.message ?? e); }`. This function is documented as best-effort and every other failure path in it already degrades to "return what we have"; without the wrap a misconfigured gateway would 500 the whole conciliação page instead of just leaving the bootstrap empty. Keep the existing `if (items.length > 0) { KV.put … }` outside the try.

### 3.3 `src/index.ts` — webhook re-registration (777, 791, 802, 818)

```ts
// before (777)
  const LODGIFY = "https://api.lodgify.com";
// after
  const gw = resolveLodgifyGateway(c.env);
```
```ts
// 791 before
  const listRes = await fetch(`${LODGIFY}/webhooks/v1/list`, { headers: { "X-ApiKey": apiKey } });
// after
  const listRes = await lodgifyFetch(gw, "/webhooks/v1/list", { headers: { "X-ApiKey": apiKey } });
```
```ts
// 802 before
      const dr = await fetch(`${LODGIFY}/webhooks/v1/unsubscribe/${wId}`, {
        method, headers: { "X-ApiKey": apiKey },
      }).catch(() => null);
// after
      const dr = await lodgifyFetch(gw, `/webhooks/v1/unsubscribe/${wId}`, {
        method, headers: { "X-ApiKey": apiKey },
      }).catch(() => null);
```
```ts
// 818 before
    const res = await fetch(`${LODGIFY}/webhooks/v1/subscribe`, {
      method: "POST",
      headers: { "X-ApiKey": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ target_url: url, event }),
    });
// after
    const res = await lodgifyFetch(gw, "/webhooks/v1/subscribe", {
      method: "POST",
      headers: { "X-ApiKey": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ target_url: url, event }),
    });
```

Import at the top of `src/index.ts` (near line 49-50, with the other lodgify imports):
```ts
import { resolveLodgifyGateway, lodgifyFetch, isGatewayFailure, LODGIFY_DIRECT_BASE, type LodgifyGateway } from "./services/lodgify-api";
```

### 3.4 `src/index.ts` — the poll (2706, 2741, 2746, 2750, 3130)

**Delete line 2706** (`const LODGIFY_API = "https://api.lodgify.com";`) — after §3.5 fixes its other consumer.

```ts
// 2741 before
async function listLodgifyBookings(apiKey: string): Promise<any[]> {
// after
async function listLodgifyBookings(gw: LodgifyGateway, apiKey: string): Promise<any[]> {
```
```ts
// 2746 before
    const url = `${LODGIFY_API}/v1/reservation?offset=${page * limit}&limit=${limit}&trash=False`;
// after
    const path = `/v1/reservation?offset=${page * limit}&limit=${limit}&trash=False`;
```
```ts
// 2750 before
      const res = await fetch(url, { headers });
// after
      const res = await lodgifyFetch(gw, path, { headers });
```
```ts
// 3130 before
      bookings = await listLodgifyBookings(apiKey);
// after
      bookings = await listLodgifyBookings(resolveLodgifyGateway(env), apiKey);
```

**New SPOF handling — insert between lines 2767 and 2768** (i.e. after `lastFailure = …`, before the `if (res.status === 429)` branch):
```ts
      // The relay is a new single point of failure for every Lodgify call, and
      // its outages look nothing like Lodgify's. Without this, a dead VPS is
      // reported as "Lodgify rejected us" and the on-call remedy named in the
      // incident email (register at lodgify.com/partners) is the wrong one.
      if (isGatewayFailure(gw, res)) {
        throw new Error(`LODGIFY_GATEWAY_DOWN: ${res.status} ${res.headers.get(LODGIFY_GATEWAY_ERROR_HEADER)}`);
      }
```

**Classifier — `reportLodgifyFetchFailure`, `src/index.ts:3345`**, add a branch above `isBlocked` so the incident names the right box:
```ts
  const isGateway = o.message.includes("LODGIFY_GATEWAY_DOWN")
    || o.message.includes("LODGIFY_GATEWAY_MISCONFIGURED");
```
and in `summary`, before the `isBlocked` arm:
```ts
    summary: isGateway
      ? "O relé Lodgify (VPS com IP fixo) não respondeu — nenhuma reserva pode ser sincronizada. O problema é nosso, não do Lodgify: verificar o serviço no VPS e LODGIFY_GATEWAY_URL/KEY."
      : isBlocked ? … (unchanged)
```
with `severity: isGateway || isBlocked || isAuth ? "critical" : "error"`.

### 3.5 `src/index.ts:1206-1207` — `/admin/lodgify/diag` (the site that must stay able to go direct)

`LODGIFY_API` is gone, and this route's whole purpose is to answer "is our own IP still blocked?" — so it keeps a direct probe and gains a relay probe:

```ts
// before (1206-1207)
    const url = v.name === "v2 endpoint"
      ? `${LODGIFY_API}/v2/reservations/bookings?page=1&size=1`
      : `${LODGIFY_API}/v1/reservation?offset=0&limit=1&trash=False`;
    try {
      const res = await fetch(url, { headers: v.headers });
// after
    const path = v.name === "v2 endpoint"
      ? "/v2/reservations/bookings?page=1&size=1"
      : "/v1/reservation?offset=0&limit=1&trash=False";
    try {
      // Deliberately DIRECT. This route exists to answer "is Cloudflare's egress
      // still blocked?", which the relay would hide by answering for it. The
      // relay gets its own probe below.
      const res = await fetch(`${LODGIFY_DIRECT_BASE}${path}`, { headers: v.headers });
```
and after the variants loop, before `return c.json(...)`:
```ts
  // Relay probe: same request, through the gateway. Direct 429 + relay 200 is
  // the healthy steady state; both 429 means the relay's IP got blocked too.
  const gw = resolveLodgifyGateway(c.env);
  let gateway: any = { configured: gw.relayed, base: gw.relayed ? gw.base : null, error: gw.configError ?? null };
  if (gw.relayed && !gw.configError) {
    try {
      const res = await lodgifyFetch(gw, "/v1/reservation?offset=0&limit=1&trash=False", {
        headers: { "X-ApiKey": apiKey, "Accept": "application/json" },
      });
      const text = await res.text();
      gateway = { ...gateway, status: res.status, gateway_error: res.headers.get(LODGIFY_GATEWAY_ERROR_HEADER), body: text.slice(0, 600) };
    } catch (e: any) {
      gateway = { ...gateway, error: String(e?.message ?? e) };
    }
  }
  return c.json({ ranAt: new Date().toISOString(), gateway, results: out });
```

---

## 4. Env vars

**`src/env.ts`** — insert immediately after the `LODGIFY_POLL_ENABLED` block (currently ends at the line declaring it):

```ts
  // Lodgify egress relay. Lodgify blocked this Worker's IP on 2026-08-02 and
  // will only ever allowlist an IP address — not an API key, not an account —
  // while Cloudflare Workers have no stable egress IP. All Lodgify traffic
  // therefore leaves through one small VPS with a static IPv4.
  //
  // UNSET = direct to https://api.lodgify.com, i.e. exactly the behaviour that
  // shipped before the relay. That is the rollback: clear the variable.
  // Set => https origin of the relay, e.g. "https://lodgify-gw.rioko.online".
  LODGIFY_GATEWAY_URL?: string;
  // Shared secret the relay requires (header X-Rioko-Gateway-Key), so a relay
  // that is reachable from the internet is not an open Lodgify proxy. Set via
  // `wrangler secret put LODGIFY_GATEWAY_KEY` — never in wrangler.jsonc, which
  // is committed. Required whenever LODGIFY_GATEWAY_URL is set.
  LODGIFY_GATEWAY_KEY?: string;
```

**`wrangler.jsonc`** — add to `vars`, after `"NORMALIZE_IN_WORKER": "1",`:

```jsonc
    // Lodgify egress relay (static IPv4 VPS). Empty = direct to api.lodgify.com,
    // which is the pre-relay behaviour and the one-variable rollback.
    // The matching secret is LODGIFY_GATEWAY_KEY (`wrangler secret put`), never here.
    "LODGIFY_GATEWAY_URL": "",
```

`LODGIFY_GATEWAY_KEY` is **not** added to `vars`. Two operational notes for the runbook:

- Per `ARCHITECTURE.md §55`, a local `wrangler deploy` can wipe secrets. After any manual deploy, run `wrangler secret list` and confirm `LODGIFY_GATEWAY_KEY` is still there — otherwise `resolveLodgifyGateway` returns `configError` and every Lodgify call fails loudly (by design, but you want to know why).
- Do not point `LODGIFY_GATEWAY_URL` at a hostname that is orange-clouded on a zone carrying Worker routes: a Worker fetching its own zone can loop back into the route instead of reaching the VPS. Use a DNS-only (grey cloud) record or a subdomain outside any route pattern.

**`ARCHITECTURE.md §7 "Bindings & env"** (line 179) — append `LODGIFY_GATEWAY_URL` to the flags list and `LODGIFY_GATEWAY_KEY` to the secrets list.

---

## 5. Call sites that CANNOT be routed by this change

1. **`backoffice/src/app/api/integrations/lodgify-source/route.ts:10, 130, 137, 221`** — the Next.js backoffice registers/unsubscribes the Lodgify webhook when a merchant saves or deletes the connection. It is a **different deployment** (Cloudflare Pages, `runtime = "edge"`, its own env), so it is out of scope for a Worker code change, and Pages has no static IP either — these calls will keep getting blocked and the route will keep setting `needsManualWebhook = true`. It is not a *regression*: nothing changes for it. Two follow-ups, pick one: (a) mirror `lodgify-api.ts` into the backoffice with its own `LODGIFY_GATEWAY_URL`/`KEY`, or (b) better, have the wizard call the Worker's existing `POST /admin/lodgify/reregister-webhooks` (already routed by §3.3) instead of talking to Lodgify itself, which also removes a second copy of the merchant key from a second runtime.
2. **Inbound webhooks** `POST /webhooks/lodgify/:userId` (`src/index.ts:468`) — Lodgify calls *us*. Nothing to route; unaffected by egress IP. Do not put the relay in front of it.
3. **`src/handlers/reconciliation.ts:418`** — `https://app.lodgify.com/#/reservations/bookings/${id}` is a **permalink rendered for humans**, not a fetch. It must NOT be rewritten to the gateway base; doing so would leak the relay hostname into merchant-visible links and 404.
4. **`src/adapters/recovery/lodgify-recovery.ts`** — reads the D1 mirror (`lodgify_bookings.raw_json`) only. No Lodgify call, deliberately. No change.
5. **`lodgify-feeder/`** (Vercel cron: `api/feed.js`, `lib/lodgify.js`, `lib/merge.js`) — the earlier attempt at this problem, which failed because Vercel has no static IP either. Not routed. Once the relay is live and the poll is green for a week, delete the directory as its own README already instructs; leaving it is a second, unmonitored path to Lodgify with copies of merchant keys.
6. **`/admin/lodgify/diag`'s four header variants** (§3.5) stay direct **on purpose** — they are the instrument that measures the block. The relay probe is added alongside, not in place.

---

## 6. Tests

Repo style: `vitest`, `*.test.ts` **next to the code**, no config file (default node env), heavy doc-comment stating the failure the test pins, `vi.mock` / `vi.fn()` for boundaries (see `src/adapters/destinations/ix-find-by-reference.test.ts` and `src/services/lodgify-booking.test.ts`).

### A. `src/services/lodgify-api.test.ts` (new — the core unit)

Doc header: *"Lodgify allowlists an IP and only an IP. Every assertion here is about one thing: a Lodgify call cannot leave this Worker except through the allowlisted address, and it cannot silently stop doing so."*

Stub `globalThis.fetch` with `vi.fn()` in `beforeEach`; assert on the recorded URL/init.

| Test | Pins |
|---|---|
| unset `LODGIFY_GATEWAY_URL` → `{ base: "https://api.lodgify.com", relayed: false }` and `lodgifyFetch` hits `https://api.lodgify.com/v1/reservation?offset=0&limit=50` | the inert fallback (§4 of the brief) |
| unset → **no** `X-Rioko-Gateway-Key` on the outbound request | our shared secret never goes to Lodgify |
| set URL + key → URL becomes `https://gw.example/v1/reservation?offset=0&limit=50`, query string byte-identical | base swap preserves path+query |
| set → `X-ApiKey` header equals the merchant key, unchanged, **and** `X-Rioko-Gateway-Key` present alongside | the two credentials coexist |
| `LODGIFY_GATEWAY_HEADER.toLowerCase() !== "x-api-key"` and does not match `/^x-api-?key$/i` | **the header-collision trap**: HTTP header names are case-insensitive, `X-Api-Key` would clobber Lodgify's `X-ApiKey` |
| trailing slash (`https://gw.example/`) and a path prefix (`https://gw.example/lodgify/`) both normalise — no `//v1`, prefix retained | URL joining |
| URL set, key empty → `configError` set, `lodgifyFetch` **rejects**, and `fetch` was never called | **no silent fallback to direct**; this is the regression that would re-create the outage |
| `http://` URL → `configError`, rejects | merchant keys never travel in cleartext |
| unparseable URL → `configError`, rejects, but `resolveLodgifyGateway` itself does **not** throw | blast radius stops at Lodgify calls; Shopify/Stripe ctx construction survives |
| path without leading `/` → rejects | join bug caught at the boundary |
| `method`/`body`/`signal` pass through on a POST | `/webhooks/v1/subscribe` still works |
| `isGatewayFailure` true only when relayed **and** `x-rioko-gateway-error` present | relay outage ≠ Lodgify outage |

### B. `src/adapters/sources/lodgify-gateway-routing.test.ts` (new — the adapter actually uses it)

Stub `globalThis.fetch`; build a ctx with `lodgify: { base: "https://gw.example", relayed: true, secret: "s3cr3t" }`.

- `LodgifySource.toNormalized({ event, data: { bookingId: 4429 } }, ctx)` → the recorded URL is `https://gw.example/v2/reservations/4429`, and `X-ApiKey` is the merchant key from `ctx.sourceConfig.api_key`.
- A preloaded booking with `_enriched: false` → the enrichment call goes to `https://gw.example/v1/reservation/booking/4429` (pins the `fetchGuestDetails` threading, the one call reached through two hops of indirection).
- `_enriched: true` → **zero** fetches (existing behaviour, must survive the refactor; complements `lodgify-booking.test.ts`).
- Same first case with `relayed: false` → `https://api.lodgify.com/v2/reservations/4429`, no gateway header.

### C. `src/services/lodgify-api.no-direct-calls.test.ts` (new — the guard that outlives us)

Reads `src/**/*.ts` off disk (`node:fs`, `readdirSync` recursive) and asserts that the literal `api.lodgify.com` appears **only** in `src/services/lodgify-api.ts` and `src/index.ts` (the diag route), with an allowlist constant naming both and a comment saying why each is exempt. Rationale, stated in the test's doc comment: the failure mode is not a bug in this code, it is the *next* Lodgify call somebody adds — a seventh call site written with a bare `fetch("https://api.lodgify.com/…")` re-creates the outage for the whole fleet, and nothing else in the build would notice.

### D. Extend `src/handlers/classify-pipeline-error.test.ts` (existing file)

Two cases: an error message containing `LODGIFY_GATEWAY_DOWN` and one containing `LODGIFY_GATEWAY_MISCONFIGURED` classify as critical and are **not** conflated with `LODGIFY_IP_BLOCKED` — because the two produce opposite remedies (restart our VPS vs. register as a Lodgify partner), and the incident email tells the operator which one to do.

---

## 7. Ship order

1. Merge §1-§3 + §6 with `LODGIFY_GATEWAY_URL` empty. Fully inert; `npm test` and `npm run build` are the gate.
2. Stand up the VPS, then `wrangler secret put LODGIFY_GATEWAY_KEY`.
3. `POST /admin/lodgify/diag` for Origos — expect direct `429` + gateway `200`. That single response is the go/no-go.
4. Set `LODGIFY_GATEWAY_URL` in `wrangler.jsonc`, deploy, re-check `wrangler secret list`.
5. `POST /admin/lodgify/poll {"user_id":"<origos>","dry_run":true}` before letting the `*/30` cron bill anything.
6. Rollback at any point = clear `LODGIFY_GATEWAY_URL` and deploy. Behaviour returns to today's (blocked, but no new failure mode).

---

## 2. VPS build

Researched the repo. Two corrections to the brief before the design, because they change the proxy's requirements:

**The brief undercounts the call sites: there are 8 `fetch()` calls, not 5, and they are not all GET.**

```
src/adapters/sources/lodgify-source.ts:121   GET          /v2/reservations/{id}
src/adapters/sources/lodgify-source.ts:472   GET          /v1/reservation/booking/{id}
src/handlers/reconciliation.ts:284           GET          /v1/reservation?offset=..
src/index.ts:791                             GET          /webhooks/v1/list
src/index.ts:802                             DELETE, POST /webhooks/v1/unsubscribe/{id}
src/index.ts:818                             POST         /webhooks/v1/subscribe
src/index.ts:1206-1207                       GET          /v2/reservations/bookings, /v1/reservation  (diag probe)
src/index.ts:2746                            GET          /v1/reservation?offset=..  (poll)
```

`src/index.ts:777`'s `const LODGIFY` feeds three webhook-management calls, not one probe. A GET-only proxy would silently break webhook registration.

---

# Rioko Lodgify egress proxy — build runbook

## 0. Threat model (what the config is actually defending)

The upstream is a hardcoded literal and the `Host` header is forced, so **there is no request-controlled routing** — the box cannot be turned into a general relay by construction, only into a Lodgify relay. That leaves three real risks:

| Risk | Control |
|---|---|
| A stranger pumps traffic at Lodgify from our IP and gets us re-blocked | shared-secret header + path allowlist + fail2ban |
| Merchant Lodgify API keys land in a log file | access-log header map deleted wholesale; Caddy never logs bodies |
| The proxy silently becomes the reason Lodgify sync is dead | health endpoint, `Restart=always`, loud Worker-side failure, documented manual bypass |

The secret is the control. Everything else is depth.

---

## 1. Software choice: **Caddy 2**

**Decision: Caddy**, single site block, ~40 lines.

**vs nginx.** nginx can do this, but three things cost you: (a) TLS is a separate certbot install plus a renewal timer that fails silently months later — a whole outage class Caddy deletes; (b) `proxy_pass https://api.lodgify.com` resolves the upstream **once at startup** unless you add a `resolver` directive and route through a variable — api.lodgify.com sits behind Cloudflare and its IPs rotate, so the naive nginx config develops a mystery outage weeks in; (c) suppressing headers from the access log means writing a custom `log_format` and remembering to exclude `$http_x_apikey`, i.e. enumerate-and-hope. Caddy dials by hostname per connection (no resolver stanza) and can delete the entire header map from the log in one line.

**vs a small Node/Go service.** More control (constant-time compare, structured redaction), but you own the HTTP server, TLS, cert renewal, dependency updates, supervision and tests for something whose entire job is "forward bytes". This repo values small surgical changes; a bespoke service is the largest thing on the table for the smallest gain.

**Honest weaknesses of the Caddy choice, stated up front:**
- Caddy's `header` matcher does a plain string compare, not constant-time. A remote timing attack against a 256-bit random secret across the public internet is not practically exploitable (network jitter dominates by orders of magnitude). Accepted.
- Caddy core has no rate-limit module; the plugin needs an `xcaddy` build. Rejected as scope creep — fail2ban on repeated 403 covers the scanner case (§3.5).
- Caddyfile `{env.X}` **fails open** if the variable is unset. Handled explicitly in §6.1; do not skip that guard.

---

## 2. Hetzner provisioning

### 2.1 Server

| Field | Value | Why |
|---|---|---|
| Location | **Falkenstein (fsn1)** or Nuremberg (nbg1), DE | EU data residency; the payloads are EU property-manager bookings incl. guest names/addresses |
| Image | **Debian 12 (bookworm)** | no snap, no surprise release upgrades |
| Type | **CX22** (2 vCPU, 4 GB, 40 GB) ≈ €3.79/mo + €0.50/mo IPv4 ≈ **€4.29/mo** ex-VAT | comfortably inside budget; confirm the live price in console |
| Cheaper option | CAX11 (Arm Ampere, 2 vCPU/4 GB) ≈ €3.29/mo | everything below works unchanged; Caddy ships arm64 debs. Arm is Falkenstein/Nuremberg/Helsinki only |
| Public IPv4 | **Yes** | this is the entire point of the exercise |
| Public IPv6 | **NO — turn it off** | see §2.2, this is the single most important switch on the page |
| Backups | off | box is disposable; config lives in git (§9) |
| SSH key | your workstation's public key, added to the Hetzner project *before* creating | avoids a root password ever existing |

Under **Networking**, untick "Public IPv6". Under the primary IPv4 resource, set **"Delete the Primary IP when the server is deleted" = OFF** — an allowlisted IP is the asset here; a rebuild must reuse it. Getting this wrong means re-opening the Lodgify ticket after every rebuild.

### 2.2 Why IPv6 must be off

`api.lodgify.com` has AAAA records (Cloudflare). If the box has a global IPv6 address, Go's dialer (Caddy) and curl both prefer IPv6 under RFC 6724 — so traffic would leave from an address inside the Hetzner /64, **not** from the IPv4 you gave Lodgify to allowlist, and the block would persist while every local test looked healthy. `/etc/gai.conf` does not fix this: Go's resolver implements its own address sorting and does not read gai.conf.

One box, one job, exactly one address to allowlist. Belt-and-braces sysctl in §3.4 in case someone re-enables IPv6 in the console later.

### 2.3 SSH key from your workstation (PowerShell)

```powershell
ssh-keygen -t ed25519 -C "pedro@rioko-lodgify-proxy" -f $env:USERPROFILE\.ssh\id_ed25519_rioko
Get-Content $env:USERPROFILE\.ssh\id_ed25519_rioko.pub   # paste into Hetzner → Security → SSH keys
```

### 2.4 Reverse DNS

Hetzner console → server → **Reverse DNS** → set the PTR for the IPv4 to `lodgify-proxy.rioko.online`. Costs nothing and turns the IP into an *identified* egress in Lodgify's logs, which is precisely what their abuse heuristic flagged us for lacking.

### 2.5 Hetzner Cloud Firewall (before first boot)

Create a firewall and attach it at creation. Inbound rules only:

| Proto | Port | Source | Purpose |
|---|---|---|---|
| TCP | 22 | 0.0.0.0/0 | SSH (key-only; tighten to your ISP range if it is stable) |
| TCP | 80 | 0.0.0.0/0 | ACME HTTP-01 + HTTPS redirect |
| TCP | 443 | 0.0.0.0/0 | the proxy |

Outbound: leave unrestricted. This sits *outside* the VM, so it holds even if ufw is misconfigured.

---

## 3. Initial hardening

SSH in as root once: `ssh root@<IP>`. **Keep this session open until §3.3 is verified from a second terminal** — the Hetzner web console (VNC) is your only escape hatch otherwise.

### 3.1 Base

```bash
apt-get update && apt-get -y upgrade
apt-get install -y sudo curl ca-certificates gnupg jq ufw fail2ban unattended-upgrades apt-listchanges
timedatectl set-timezone Europe/Lisbon
hostnamectl set-hostname lodgify-proxy
```

Timezone matters: your memory already records confusing Lisbon-vs-UTC timestamps during an incident. Caddy's JSON log uses epoch regardless — `jq` renders it, see §6.3.

### 3.2 Non-root user

```bash
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
```

### 3.3 SSH lockdown — mind the drop-in ordering trap

Debian 12 and Ubuntu 24.04 both `Include /etc/ssh/sshd_config.d/*.conf` at the **top** of sshd_config, and sshd takes the **first** value it sees for any keyword. Cloud images ship `50-cloud-init.conf`. A file named `99-*.conf` therefore **loses** to it. Use a low number:

```bash
cat >/etc/ssh/sshd_config.d/00-rioko.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PubkeyAuthentication yes
PermitEmptyPasswords no
X11Forwarding no
AllowTcpForwarding no
AllowAgentForwarding no
MaxAuthTries 3
LoginGraceTime 20
AllowUsers deploy
EOF

sshd -t && sshd -T | grep -Ei '^(permitrootlogin|passwordauthentication|kbdinteractive|allowusers)'
```

`sshd -T` prints the **effective** merged config — that is the verification, not the file you just wrote. Expect `permitrootlogin no`, `passwordauthentication no`, `allowusers deploy`.

```bash
systemctl reload ssh
```

Now, from a **second terminal**: `ssh deploy@<IP> "id"`. Only when that succeeds, close the root session.

### 3.4 Firewall + IPv6 guard

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status verbose
```

Deliberately **not** `ufw limit 443/tcp`: the reconciliation poll walks up to 40 pages per tenant and ufw's rate limiter counts new connections, so it would throttle legitimate bursts. Abuse is handled by fail2ban on 403s instead.

```bash
cat >/etc/sysctl.d/99-rioko-no-ipv6.conf <<'EOF'
# The whole value of this box is ONE fixed egress address that Lodgify can
# allowlist. api.lodgify.com publishes AAAA records, and Go/curl prefer IPv6
# when a global v6 address exists — traffic would then leave from the Hetzner
# /64 instead of the allowlisted IPv4, and the block would look unfixed.
# Server is provisioned IPv4-only; this is the guard if someone re-adds v6.
net.ipv6.conf.all.disable_ipv6 = 1
net.ipv6.conf.default.disable_ipv6 = 1
EOF
sysctl --system
ip -6 addr show scope global   # must print nothing
```

### 3.5 Unattended upgrades

```bash
cat >/etc/apt/apt.conf.d/51rioko-unattended <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
// 04:45 Lisbon: after the Worker's 04:00 reconciliation sweep, before business
// hours. A reboot here is a ~30s gap the Worker retries through.
Unattended-Upgrade::Automatic-Reboot-Time "04:45";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF
systemctl enable --now unattended-upgrades
unattended-upgrade --dry-run --debug 2>&1 | tail -20
```

Scoped to Debian security origins only. Caddy comes from Cloudsmith and is deliberately **not** auto-upgraded — do it by hand monthly (§9.3) rather than have a third-party repo restart your only Lodgify path unattended.

### 3.6 fail2ban — warranted, with one important exclusion

Warranted because 443 is public and a header secret is the only thing between the internet and merchant credentials; scanners will find it.

```bash
cat >/etc/fail2ban/jail.local <<'EOF'
[DEFAULT]
backend  = systemd
banaction = ufw
bantime  = 1h
findtime = 10m
maxretry = 5

[sshd]
enabled = true
maxretry = 3
bantime  = 24h
EOF
```

`backend = systemd` matters: Ubuntu 24.04 has no `/var/log/auth.log`, and the file backend would sit there matching nothing.

```bash
cat >/etc/fail2ban/filter.d/caddy-lodgify.conf <<'EOF'
[Definition]
# Caddy JSON access log. The header map is deleted by the log filter (see
# Caddyfile), so nothing but real request fields can appear on the line —
# a header value can never spoof this pattern.
failregex = ^\{.*"remote_ip":"<HOST>".*"status":403
ignoreregex =
datepattern = "ts":{EPOCH}
EOF

cat >/etc/fail2ban/jail.d/caddy-lodgify.local <<'EOF'
[caddy-lodgify]
enabled  = true
backend  = auto
filter   = caddy-lodgify
logpath  = /var/log/caddy/lodgify-proxy.log
port     = http,https
maxretry = 8
findtime = 5m
bantime  = 1h
# Cloudflare egress ranges are ignored ON PURPOSE. `wrangler deploy` from a
# laptop wipes Worker secrets; the first symptom is the Worker sending requests
# with no proxy key, i.e. a burst of 403s from Cloudflare IPs. Banning those
# would take down every merchant's Lodgify sync intermittently and be
# maddening to diagnose. Fail2ban here is for random scanners; the shared
# secret is the actual control.
ignoreip = 127.0.0.1/8 CF_RANGES_HERE
EOF

# Fill in the Cloudflare ranges (re-run if you ever edit this jail):
CF=$(curl -s https://www.cloudflare.com/ips-v4 | tr '\n' ' ')
sed -i "s|CF_RANGES_HERE|$CF|" /etc/fail2ban/jail.d/caddy-lodgify.local
```

Start it after Caddy exists (§4), then verify the regex actually matches — never assume:

```bash
fail2ban-regex /var/log/caddy/lodgify-proxy.log /etc/fail2ban/filter.d/caddy-lodgify.conf
fail2ban-client status caddy-lodgify
```

---

## 4. Caddy install + the proxy config

### 4.1 Install

```bash
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
install -d -o caddy -g caddy -m 750 /var/log/caddy
caddy version
```

### 4.2 The shared secret

```bash
umask 077
printf 'RIOKO_PROXY_KEY=%s\n' "$(openssl rand -hex 32)" > /etc/caddy/lodgify-proxy.env
chmod 600 /etc/caddy/lodgify-proxy.env
chown root:root /etc/caddy/lodgify-proxy.env
```

Root-owned 0600 is correct: systemd reads `EnvironmentFile` as root before dropping to the `caddy` user. Keeping it out of the Caddyfile means the Caddyfile itself is safe to commit and paste.

To read it once, for pasting into `wrangler secret put` (and nothing else):

```bash
sudo sed -n 's/^RIOKO_PROXY_KEY=//p' /etc/caddy/lodgify-proxy.env
```

### 4.3 `/etc/caddy/Caddyfile` — complete, copy-pasteable

Replace `lodgify-proxy.rioko.online` and the two e-mail addresses.

```caddyfile
# ─────────────────────────────────────────────────────────────────────────────
# Rioko — Lodgify egress proxy
#
# WHY THIS EXISTS
#   Since 2026-08-02 Lodgify blocks the Cloudflare Worker's egress: "flagged as
#   an unregistered API user requesting data for multiple Lodgify end users."
#   Cloudflare Workers have no stable egress IP. Lodgify support confirmed in
#   writing that they can only allowlist by IP, and that a dedicated static IP
#   solves it. This box IS that IP: one stable, identified egress — the same
#   posture lodgify-feeder/README.md already prescribed, done properly.
#   It is NOT IP rotation to evade a block. Partner registration continues in
#   parallel; when it lands, this box and lodgify-feeder/ both get deleted.
#
# WHAT IT IS NOT
#   Not a general proxy. The upstream is a literal below and the Host header is
#   forced, so no request can steer it anywhere but api.lodgify.com. Merchant
#   Lodgify keys pass through in X-ApiKey untouched and are never logged.
# ─────────────────────────────────────────────────────────────────────────────

{
	email ops@rioko.online

	servers {
		timeouts {
			# A client that opens a socket and dawdles must not hold a slot.
			read_body   10s
			read_header 5s
			write       60s
			idle        75s
		}
	}
}

lodgify-proxy.rioko.online {

	# ── Access log ───────────────────────────────────────────────────────────
	# Caddy logs the FULL request header map by default and only auto-redacts
	# Authorization/Cookie. X-ApiKey is NOT on that list, so a stock install
	# writes every merchant's Lodgify credential to disk in plaintext.
	#
	# Two further traps: Go canonicalises header names, so "X-ApiKey" appears in
	# the map as "X-Apikey" and a filter written against the original spelling
	# silently matches nothing. And a future call site could add a new sensitive
	# header nobody remembers to add here.
	#
	# So: delete the whole map rather than enumerate. We lose nothing we need —
	# method, URI, status, duration and remote_ip all live outside it. Caddy has
	# no body logging at all, so request bodies are excluded by construction.
	log {
		output file /var/log/caddy/lodgify-proxy.log {
			roll_size     10MiB
			roll_keep     5
			roll_keep_for 336h
		}
		format filter {
			wrap json
			fields {
				request>headers delete
				resp_headers    delete
			}
		}
	}

	header {
		-Server
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
	}

	# ── Liveness ─────────────────────────────────────────────────────────────
	# Unauthenticated on purpose: uptime monitors and the Worker's cron must be
	# able to probe it. Deliberately does NOT touch Lodgify — a health check
	# that called their API would be exactly the unsolicited traffic that got us
	# blocked, and would report the proxy as down whenever Lodgify was down.
	handle /healthz {
		header Content-Type application/json
		respond `{"ok":true,"service":"rioko-lodgify-proxy"}` 200
	}

	# ── Everything else ──────────────────────────────────────────────────────
	handle {
		# `route` forces the written order. Without it Caddy applies its own
		# directive ordering and the auth check could run after the proxy.
		route {
			# Methods actually used by the Worker: GET (fetch/list/diag),
			# POST (webhooks/v1/subscribe, unsubscribe fallback), DELETE
			# (webhooks/v1/unsubscribe). Nothing else has a caller.
			@bad_method not method GET POST DELETE
			respond @bad_method 405

			# Shared secret. Note the name: deliberately NOT "x-api-key" (the
			# Worker's own admin header) and NOT "X-ApiKey" (the merchant's
			# Lodgify credential). Those two already differ by one hyphen; a
			# third look-alike is how a merchant key ends up pasted into the
			# proxy secret slot.
			@unauthorized not header X-Rioko-Proxy-Key {env.RIOKO_PROXY_KEY}
			respond @unauthorized 403

			# Path allowlist. Covers every current call site:
			#   /v1/reservation, /v1/reservation/booking/{id}
			#   /v2/reservations/{id}, /v2/reservations/bookings
			#   /webhooks/v1/{list,subscribe,unsubscribe/{id}}
			# Prefixes rather than exact paths: exact matching turns any new
			# Lodgify call into a mystery 404 months from now, and the real
			# containment is the fixed upstream plus the secret, not this.
			@not_lodgify not path /v1/* /v2/* /webhooks/v1/*
			respond @not_lodgify 404

			# Largest legitimate body is the webhook-subscribe JSON (~200 B).
			request_body {
				max_size 256KB
			}

			reverse_proxy https://api.lodgify.com {
				# Caddy preserves the INBOUND Host by default, which would send
				# "lodgify-proxy.rioko.online" to Lodgify's WAF and earn a 403.
				header_up Host api.lodgify.com

				# Identify ourselves. This string is what Lodgify support should
				# see next to the allowlisted IP.
				header_up User-Agent "Rioko/1.0 (+https://rioko.online; lodgify-integration; ops@rioko.online)"

				# Never forward our own secret upstream.
				header_up -X-Rioko-Proxy-Key

				# Caddy adds X-Forwarded-* by default. Forwarding them would
				# tell Lodgify "this request was relayed on behalf of another
				# address" — literally the pattern their heuristic flagged. One
				# identified client, one address.
				header_up -X-Forwarded-For
				header_up -X-Forwarded-Proto
				header_up -X-Forwarded-Host
				header_up -Forwarded

				# Same reasoning for anything Cloudflare stamped on the way in.
				header_up -Cf-Connecting-Ip
				header_up -Cf-Ray
				header_up -Cf-Ipcountry
				header_up -Cf-Visitor
				header_up -Cf-Worker

				# Lets the Worker assert a response really came via this box.
				header_down +X-Rioko-Proxy lodgify-proxy

				transport http {
					dial_timeout            10s
					tls_timeout             10s
					response_header_timeout 30s
					# A warm TLS session to Lodgify: fewer handshakes, less
					# noise in their connection logs.
					keepalive               90s
					keepalive_idle_conns    4
				}
				# No response buffering configured, so Caddy streams both ways
				# by default — nothing accumulates in RAM.
			}
		}
	}
}
```

Note the DNS behaviour that made this Caddy and not nginx: `reverse_proxy` dials `api.lodgify.com` by name on every new connection, so Cloudflare rotating the upstream IPs is a non-event. No `resolver` stanza, nothing to forget.

### 4.4 Validate before starting

```bash
caddy fmt --overwrite /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --envfile /etc/caddy/lodgify-proxy.env
```

Never run `caddy adapt` and paste the output anywhere: the adapted JSON contains the **expanded** secret.

---

## 5. TLS and DNS

### 5.1 DNS

Add at your DNS provider:

```
lodgify-proxy.rioko.online.   A   300   <HETZNER_IPV4>
```

No AAAA record. If rioko.online is on Cloudflare, set this record to **DNS only (grey cloud)**. Orange-cloud proxying would put Cloudflare back in front of the hop you are specifically trying to take off Cloudflare, complicate ACME, and make `X-Rioko-Proxy` a weaker proof of path.

Confirm propagation before starting Caddy, or ACME burns a rate-limited failure:

```bash
dig +short lodgify-proxy.rioko.online A
dig +short lodgify-proxy.rioko.online AAAA   # must be empty
```

### 5.2 Certificate

Automatic. Caddy solves HTTP-01 on port 80 (open in §3.4/§2.5) or TLS-ALPN-01 on 443, obtains from Let's Encrypt (ZeroSSL fallback), renews at ~2/3 lifetime, and reloads itself. No certbot, no cron, no renewal timer to fail silently in February. The `email` in the global block is where expiry warnings go if renewal ever does break.

---

## 6. systemd, logging, and what must never be logged

### 6.1 Drop-in — two things the packaged unit gets wrong for us

```bash
mkdir -p /etc/systemd/system/caddy.service.d
cat >/etc/systemd/system/caddy.service.d/override.conf <<'EOF'
[Service]
EnvironmentFile=/etc/caddy/lodgify-proxy.env

# FAIL-CLOSED GUARD. Caddyfile {env.X} expands to nothing when the variable is
# missing, which turns the auth matcher into "header present with any value";
# negated, that means any request carrying the header passes. An unset secret
# would therefore silently open the proxy instead of breaking it. Refuse to
# start at all rather than start unprotected. ($$ = literal $ for systemd.)
ExecStartPre=/bin/sh -c 'test $${#RIOKO_PROXY_KEY} -ge 32'

# The packaged unit runs `caddy run --environ`, which DUMPS THE ENTIRE PROCESS
# ENVIRONMENT into the journal at every start — RIOKO_PROXY_KEY included.
# Empty ExecStart= clears the packaged value, then we re-declare it without it.
ExecStart=
ExecStart=/usr/bin/caddy run --config /etc/caddy/Caddyfile

Restart=always
RestartSec=5s
EOF

systemctl daemon-reload
systemctl enable --now caddy
systemctl status caddy --no-pager
systemctl start fail2ban
```

Confirm the leak is closed:

```bash
journalctl -u caddy --no-pager | grep -ci RIOKO_PROXY_KEY   # must be 0
```

### 6.2 Log rotation

Handled inside Caddy by the `roll_size 10MiB / roll_keep 5 / roll_keep_for 336h` block — no logrotate config, one less thing to drift. That is ~50 MB ceiling and a 14-day horizon, which is enough to investigate an incident and short enough that stale request metadata does not pile up.

Cap the journal too, on a 40 GB disk:

```bash
sed -i 's/^#\?SystemMaxUse=.*/SystemMaxUse=200M/' /etc/systemd/journald.conf
systemctl restart systemd-journald
```

### 6.3 What must never be logged or printed

| Never | Why | Enforced by |
|---|---|---|
| `X-ApiKey` | merchant's own Lodgify credential | `request>headers delete` in the log filter |
| `X-Rioko-Proxy-Key` | opens the proxy | same |
| request/response bodies | guest names, addresses, e-mails | Caddy has no body logging |
| `caddy adapt` output, `curl localhost:2019/config/` | both contain the **expanded** secret | discipline; the admin API is localhost-only |
| the env file contents in a ticket/chat | — | `sed -n 's/^KEY=//p'` prints one field, never `cat` the file |

Reading the log safely:

```bash
sudo tail -f /var/log/caddy/lodgify-proxy.log \
  | jq -r '[(.ts|todate), .request.remote_ip, .request.method, .request.uri, .status, (.duration|tostring)] | @tsv'
```

---

## 7. Health endpoint

`GET https://lodgify-proxy.rioko.online/healthz` → `200 {"ok":true,"service":"rioko-lodgify-proxy"}`, unauthenticated, no Lodgify call.

It answers exactly one question — *is the proxy process alive and serving TLS* — and deliberately does not conflate that with *is Lodgify up* or *is this merchant's key valid*. Those are separate failures with separate fixes; a health check that merges them is how you spend an hour rebooting a healthy box during a Lodgify outage.

Worker side: probe it from the existing cron, and treat a failure as a distinct, named incident (`lodgify_proxy_unreachable`), never as "zero bookings". The repo already learned this exact lesson at `src/index.ts:2760` — *"A 200 whose body isn't JSON is a bot/WAF challenge or an outage page, NOT 'this account has no bookings'. Treating it as an empty list is how a dead poll looks identical to an idle one."* A dead proxy must not look like a quiet week.

Also point an external monitor (UptimeRobot free tier, 5-minute interval) at `/healthz` — a self-monitoring system cannot report its own total failure.

---

## 8. Verification — proving the egress IP is the VPS

Run in order. Every step has an expected value; a step without one proves nothing.

### 8.1 The box's own egress is the static IPv4

```bash
ssh deploy@<IP> 'curl -4 -s https://api.ipify.org; echo'
# → exactly the Hetzner IPv4

ssh deploy@<IP> 'ip -6 addr show scope global'
# → empty. If this prints an address, STOP: §2.2.

ssh deploy@<IP> "curl -s -o /dev/null -w 'local=%{local_ip} remote=%{remote_ip} code=%{http_code}\n' https://api.lodgify.com/"
# → local=<Hetzner IPv4>  remote=<IPv4>  — both v4. `local_ip` is the source
#   address curl actually bound, i.e. direct proof of the egress address.
```

### 8.2 Lodgify accepts that IP (the decisive test)

On the VPS. The leading space keeps it out of shell history; `read -rs` keeps the key off the screen and out of the process list.

```bash
ssh deploy@<IP>
 unset HISTFILE
 read -rs -p 'Lodgify API key: ' LK; echo
 curl -sS -o /dev/null -w 'status=%{http_code} local=%{local_ip}\n' \
   -H "X-ApiKey: $LK" -H 'Accept: application/json' \
   -H 'User-Agent: Rioko/1.0 (+https://rioko.online; lodgify-integration)' \
   'https://api.lodgify.com/v1/reservation?offset=0&limit=1&trash=False'
 unset LK
# → status=200. A 429 with the "This IP address has been blocked" body means
#   the new IP inherited the block or the range is flagged — raise it with
#   Matthew with this IP and the rDNS name before going further.
```

### 8.3 The proxy itself (from your Windows workstation)

```powershell
$P = "https://lodgify-proxy.rioko.online"
$env:PK = "<RIOKO_PROXY_KEY>"

# TLS + health
curl.exe -sS -D - -o NUL $P/healthz
# → HTTP/2 200, issuer Let's Encrypt (curl.exe -vI to see the chain)

# no secret -> 403
curl.exe -s -o NUL -w "no-secret=%{http_code}`n" $P/v1/reservation

# wrong secret -> 403
curl.exe -s -o NUL -w "bad-secret=%{http_code}`n" -H "X-Rioko-Proxy-Key: nope" $P/v1/reservation

# off-allowlist path -> 404 (and never reaches Lodgify)
curl.exe -s -o NUL -w "bad-path=%{http_code}`n" -H "X-Rioko-Proxy-Key: $env:PK" $P/admin

# disallowed method -> 405
curl.exe -s -o NUL -w "bad-method=%{http_code}`n" -X PUT -H "X-Rioko-Proxy-Key: $env:PK" $P/v1/reservation

# not an open relay: absolute-URI and Host override must still hit Lodgify only
curl.exe -s -o NUL -w "host-override=%{http_code}`n" -H "X-Rioko-Proxy-Key: $env:PK" -H "Host: evil.example" $P/v1/reservation
```

Expected: `403, 403, 404, 405`, and the Host-override attempt behaves identically to a normal request (Lodgify's 401 for the missing key) — never a connection to `evil.example`.

### 8.4 End-to-end with a real key, through the proxy

```powershell
$env:LK = "<merchant Lodgify key>"
curl.exe -sS -D - -o NUL `
  -H "X-Rioko-Proxy-Key: $env:PK" -H "X-ApiKey: $env:LK" -H "Accept: application/json" `
  "$P/v1/reservation?offset=0&limit=1&trash=False"
Remove-Item Env:LK
```

Expected: `HTTP/2 200` **and** an `X-Rioko-Proxy: lodgify-proxy` response header — 200 proves Lodgify accepted the new egress, the header proves the answer came through this box and not from some cached path.

### 8.5 The fail-closed guard actually fails closed

```bash
sudo mv /etc/caddy/lodgify-proxy.env /root/env.bak
sudo systemctl restart caddy          # must FAIL
systemctl is-active caddy             # → failed
sudo mv /root/env.bak /etc/caddy/lodgify-proxy.env
sudo systemctl restart caddy && systemctl is-active caddy   # → active
```

If Caddy starts without the env file, the auth matcher is open — stop and fix §6.1 before routing any traffic.

### 8.6 Nothing sensitive reached disk

Generate traffic (§8.4), then:

```bash
ssh deploy@<IP> 'sudo grep -ric "apikey\|x-rioko-proxy-key" /var/log/caddy/ ; sudo journalctl -u caddy --no-pager | grep -ci apikey'
# → 0 and 0
```

Run this **after** real traffic, not before. It is the only thing that distinguishes "the filter works" from "the filter has a typo and silently matched nothing".

### 8.7 Worker traffic really transits the box

Tail the log while triggering the Worker's Lodgify diag route:

```bash
ssh deploy@<IP> 'sudo tail -f /var/log/caddy/lodgify-proxy.log | jq -r "[.request.method,.request.uri,.status]|@tsv"'
```

You should see the `/v1/reservation?offset=0&limit=1&trash=False` and `/v2/reservations/bookings?page=1&size=1` probes from `src/index.ts:1206-1207` appear live. If they do not, the Worker is still going direct — check `LODGIFY_PROXY_URL`.

---

## 9. This is a new single point of failure. Say so, and handle it.

Before today, Lodgify sync failed only if Lodgify or Cloudflare failed. It now also fails if a €4 VPS in Falkenstein reboots, fills its disk, or loses its cert. That is a real regression in the dependency graph, accepted because the alternative is 100% failure, which is where we are.

**Mitigations, in order of how much they actually buy:**

1. **Loud failure.** The Worker must distinguish *proxy unreachable* from *no bookings* and open an incident. Silent degradation is the failure mode this repo has been burned by repeatedly (`buildNormalizedFromRaw` SPOF, the "200 with unparseable body" comment, the phantom "por emitir" digests).
2. **Kill switch.** `LODGIFY_PROXY_URL` is a plain var in `wrangler.jsonc`, not a secret. Blank it and redeploy and the Worker goes direct to `api.lodgify.com` in one line. That restores the *old* broken state, not a working one — but it removes the proxy from the blame surface in 90 seconds during an incident.
3. **Manual bypass, already built.** `POST /admin/lodgify/poll` with caller-supplied raw v1 bookings still works from your laptop (your recorded recovery lever). The proxy being down never means a merchant *cannot* be invoiced, only that it is not automatic.
4. `Restart=always` + `RestartSec=5s`, `systemctl enable caddy` (survives reboot), reboots pinned to 04:45 after the sweep.
5. **External uptime monitor** on `/healthz`.
6. **Rebuild is 10 minutes, and keeps the IP.** The primary IPv4 is reserved (§2.1), so a destroy/recreate reuses the allowlisted address. Nothing on the box is precious.

### 9.1 Keep the whole box in git

```
ops/lodgify-proxy/
  README.md                 ← this runbook, trimmed
  Caddyfile                 ← §4.3 verbatim (contains no secret)
  caddy.service.d/override.conf
  fail2ban/filter.d/caddy-lodgify.conf
  fail2ban/jail.d/caddy-lodgify.local
  sshd_config.d/00-rioko.conf
  sysctl.d/99-rioko-no-ipv6.conf
  cloud-init.yaml           ← §9.2
```

Only `/etc/caddy/lodgify-proxy.env` is not in git. Rebuild = new server from the same reserved IP + cloud-init + one `openssl rand` + one `wrangler secret put`.

### 9.2 `cloud-init.yaml` (paste into Hetzner's "user data" at creation)

```yaml
#cloud-config
users:
  - name: deploy
    groups: [sudo]
    shell: /bin/bash
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    ssh_authorized_keys:
      - ssh-ed25519 AAAA... pedro@rioko-lodgify-proxy
package_update: true
package_upgrade: true
packages: [curl, ca-certificates, gnupg, jq, ufw, fail2ban, unattended-upgrades, debian-keyring, debian-archive-keyring, apt-transport-https]
write_files:
  - path: /etc/ssh/sshd_config.d/00-rioko.conf
    content: |
      PermitRootLogin no
      PasswordAuthentication no
      KbdInteractiveAuthentication no
      AllowUsers deploy
  - path: /etc/sysctl.d/99-rioko-no-ipv6.conf
    content: |
      net.ipv6.conf.all.disable_ipv6 = 1
      net.ipv6.conf.default.disable_ipv6 = 1
runcmd:
  - [ sh, -c, "ufw default deny incoming && ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable" ]
  - [ sh, -c, "sysctl --system" ]
  - [ sh, -c, "curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg" ]
  - [ sh, -c, "curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list" ]
  - [ sh, -c, "apt-get update && apt-get install -y caddy" ]
  - [ sh, -c, "install -d -o caddy -g caddy -m 750 /var/log/caddy" ]
  - [ systemctl, reload, ssh ]
```

Then copy in the Caddyfile, the systemd drop-in and the fail2ban files from git, generate a fresh secret, `wrangler secret put`, run §8.

### 9.3 Monthly, 5 minutes

```bash
ssh deploy@<IP> 'sudo apt-get update && sudo apt-get -y upgrade && caddy version && sudo systemctl is-active caddy fail2ban && sudo fail2ban-client status caddy-lodgify && df -h /'
```

Plus: re-run §8.4 (a cert that failed to renew looks fine until it doesn't) and re-check `curl -4 -s https://api.ipify.org` still matches the IP Lodgify allowlisted.

---

## 10. The Worker-side contract (interface only — not this task's implementation)

The proxy assumes exactly this, and the config above is written to it:

```ts
// One shared constant replaces two local constants and six hardcoded literals
// across 8 fetch() call sites. Blank LODGIFY_PROXY_URL = go direct (kill switch).
const LODGIFY_BASE = env.LODGIFY_PROXY_URL || "https://api.lodgify.com";
```

- `LODGIFY_PROXY_URL` → **var** in `wrangler.jsonc`: `"https://lodgify-proxy.rioko.online"`.
- `LODGIFY_PROXY_KEY` → **secret**: `wrangler secret put LODGIFY_PROXY_KEY`. Add `X-Rioko-Proxy-Key` on every Lodgify request, and **only** when `LODGIFY_PROXY_URL` is set (never send it to `api.lodgify.com` direct).
- Path and query pass through byte-for-byte; `X-ApiKey` passes through untouched; `GET`/`POST`/`DELETE` all supported.
- **Do not set `User-Agent` in the Worker** — the proxy overwrites it with the identified Rioko string. Two sources of truth for the identity Lodgify allowlisted is a foot-gun.
- Treat `403` from the proxy as *our misconfiguration* (missing/stale proxy key), never as *Lodgify rejected the merchant* — those need different alerts. `401` from Lodgify remains the merchant-key signal.

**After adding the secret, run `wrangler secret list`.** Your own recorded lesson: a local `wrangler deploy` wipes Worker secrets, and here the first symptom would be a fleet-wide burst of 403s at the proxy, which is why §3.6 excludes Cloudflare ranges from fail2ban.

---

## 11. Cleanup and the Lodgify conversation

- **Delete `lodgify-feeder/`** once §8 passes end to end. Its own README says to: *"When partner registration lands, delete this project."* This box is the stable identified egress that README asked for; keeping a second, half-working fetch path is how the two silently start disagreeing about what a booking is.
- **Send Matthew**, in one message: the IPv4, the rDNS name `lodgify-proxy.rioko.online`, the exact User-Agent string, the current count of connected end users (well under the stated 20), and the polling cadence. Ask him to allowlist the IP. Keep the partner registration open in parallel — the allowlist is the unblock, partner status is the durable fix, and this box gets deleted when it lands.
- Keep the cadence conservative and keep honouring `Retry-After` (the code already does, `src/handlers/reconciliation.ts:296` and `src/index.ts:2760`). A fixed IP that then hammers them is a fixed IP that gets blocked again, permanently and by a human.

---

## 3. Adversarial review — read before building

Findings below. I read the actual tree at `c:\dev\shopifyix` (branch `feat/document-log`) rather than trusting either inventory; both inventories are incomplete.

---

## CRITICAL

**1. Neither design captures the backoffice's Lodgify egress — the onboarding wizard still calls Lodgify from Cloudflare Pages.**
`C:\dev\shopifyix\backoffice\src\app\api\integrations\lodgify-source\route.ts:10` declares its own `const LODGIFY_API = "https://api.lodgify.com"` and makes three calls with `runtime = "edge"` (Cloudflare Pages, no static IP either): `DELETE /v2/webhooks/{id}`, `POST /webhooks/v1/subscribe`, `DELETE /webhooks/v1/unsubscribe/{id}`. The runbook's 8-site inventory omits them entirely; the spec waves at "two more places … see §5" but the allowlist it hands the proxy (`^/v1/reservation`, `^/v2/reservations/`, `^/webhooks/v1/`) **does not contain `/v2/webhooks/`**, so even if the backoffice were routed it would 403. Result: onboarding the next Lodgify merchant still hits Lodgify from an unallowlisted Cloudflare IP, which is exactly the fingerprint that got us flagged.
**Fix:** route the backoffice through the same gateway (a Pages-side `LODGIFY_GATEWAY_URL`/`_KEY` pair, or better: delete the direct calls and have the wizard `POST /admin/lodgify/reregister-webhooks` on the Worker, which already does this properly). Add `^/v2/webhooks/` to the allowlist and derive the allowlist from one list checked into the repo, not retyped in a Caddyfile.

**2. The Vercel feeder is still deployed and still hourly — a second, unallowlisted IP pulling several end users' data.**
`lodgify-feeder/vercel.json` schedules `/api/feed` at `7 * * * *`, and `lodgify-feeder/lib/lodgify.js:12` hits `api.lodgify.com` per tenant. Nothing in either design decommissions it. After the allowlist lands you would have a clean identified IP *and* a rotating Vercel IP doing the exact behaviour Lodgify names in the block text. Lodgify's next escalation may be at the account/key level, not the IP level, and then the allowlist buys nothing.
**Fix:** make "delete the Vercel project and remove `lodgify-feeder/`" a numbered, blocking step in the cutover, before the first proxied poll — not a "when partner registration lands" someday item. `lodgify-feeder/README.md` already says to delete it.

**3. `GET /admin/lodgify/feed-manifest` hands out every merchant's plaintext Lodgify API key, and the proxy design leaves it in place.**
`src/index.ts:1015-1055` returns `tenants[].api_key` in cleartext for every active connection. It exists only to feed the Vercel project (#2). Once the gateway lands, it is a standing credential-exfiltration endpoint whose only control is `ADMIN_API_KEY` — the same shared secret that is pasted into scripts and `backoffice/.env.local`.
**Fix:** delete the route in the same PR as the gateway. If a manual bypass is still wanted, `POST /admin/lodgify/poll {user_id, bookings}` (`src/index.ts:980`) already accepts caller-supplied bookings without ever exporting a key.

**4. Silent fallback to direct is the default, and this repo has a documented history of `wrangler deploy` wiping secrets.**
`resolveLodgifyGateway` returns `{ base: LODGIFY_DIRECT_BASE, relayed: false }` when `LODGIFY_GATEWAY_URL` is empty. `scripts/deploy.mjs` header, item 2, says in as many words: *"`wrangler deploy` from a machine whose wrangler config does not carry them has silently dropped this worker's secrets before"* — and the user's own notes record `wrangler deploy` deleting secrets. If `LODGIFY_GATEWAY_URL` is stored as a secret and gets dropped, the fleet silently reverts to direct egress and re-earns the block, with no error anywhere. The spec's own comment claims "a misconfigured relay must NEVER silently fall back to direct" — but unset is precisely a silent fall back to direct.
**Fix:** three-state, fail-closed. Put `LODGIFY_EGRESS_MODE` in `wrangler.jsonc` `vars` (survives a bare deploy, is reviewable in git, contains no secret): `"gateway"` after cutover. Absent or `"gateway"` ⇒ gateway required; a missing URL or key becomes `configError`, and `lodgifyFetch` rejects. Only an explicit `"direct"` restores the old path. Put `LODGIFY_GATEWAY_URL` in `vars` too (it is a hostname, not a secret) so only the key is a secret that can vanish.

**5. `LODGIFY_GATEWAY_KEY` will end up in git if the repo's own precedent is followed.**
`wrangler.jsonc:26` already carries `"NORMALIZE_SHOPIFY_ORDER_API_KEY": "2b752911-eb5a-4659-b353-f07a53a3680d"` as a committed plaintext var. Neither document says "secret, not var".
**Fix:** state explicitly `wrangler secret put LODGIFY_GATEWAY_KEY`, add it to whatever list `scripts/deploy.mjs` diffs before/after deploy so a wipe is named, and add a `scripts/security-self-check.mjs` assertion that no `LODGIFY_GATEWAY_KEY` appears in `wrangler.jsonc`.

---

## HIGH

**6. Caddy forwards `X-Forwarded-For` to Lodgify by default — you would hand Lodgify the very Cloudflare egress IPs you are consolidating away from.**
`reverse_proxy` adds `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` unless told not to. Lodgify's abuse heuristic reading XFF (or a support engineer reading a request dump) sees a rotating Cloudflare address behind a "static" IP. Embarrassing and self-defeating.
**Fix:** `header_up -X-Forwarded-For`, `-X-Forwarded-Proto`, `-X-Forwarded-Host`, `-X-Rioko-Gateway-Key`, and set a single stable `header_up User-Agent "Rioko/1.0 (+https://rioko.online; ops@rioko.online)"`.

**7. `/admin/lodgify/diag` deliberately spoofs a Chrome User-Agent, and the design routes it through the newly allowlisted IP.**
`src/index.ts:1200` sends `Mozilla/5.0 (Windows NT 10.0; Win64; x64) … Chrome/126.0` plus three other UA variants in a 4-request burst against an API. That is textbook evasion signature. Running it from the allowlisted IP is the fastest way to lose the allowlist, and if a human at Lodgify ever looks, it reads as bad faith.
**Fix:** delete the browser-spoof variant (and probably the whole route — it was written to characterise the block, which is now understood). At minimum, gate it behind an env flag that is off, and never let it reach the gateway.

**8. Booking IDs are interpolated into the path unescaped, and the inbound webhook skips HMAC when no secret is stored — so a stranger can choose the path the proxy requests.**
`src/adapters/sources/lodgify-source.ts:121` and `:472` build `` `…/v2/reservations/${bookingId}` `` with no `encodeURIComponent`. `src/index.ts:497` logs *"no webhook_secret for … — skipping HMAC verification"* and proceeds; secretless connections are the normal state (the backoffice sets `needs_manual_webhook` exactly when Lodgify returns no secret). So `POST /webhooks/lodgify/<userId>` with `data.bookingId = "bookings?limit=9999&x="` (or `../…`) lets an unauthenticated caller steer the proxied path — defeating the path allowlist and burning the allowlisted IP's reputation with someone else's request shape. Today this is Lodgify's problem; after the gateway it is *our IP's* problem.
**Fix:** `encodeURIComponent(bookingId)` at both sites; reject non-`[A-Za-z0-9_-]{1,64}` booking ids before the fetch; and change `:497` to refuse the webhook when no secret is configured rather than accepting it unverified.

**9. The Worker contract requires `X-Rioko-Gateway-Error` on relay-generated failures; a plain Caddy `reverse_proxy` never sets it, so `isGatewayFailure()` is permanently false.**
The two documents do not join up. Caddy's default 502 on an unreachable upstream carries no custom header, and the 403 path in the runbook is a bare `respond 403`. So "our VPS is down" and "Lodgify is down" remain indistinguishable — the exact thing the header was invented for. `isGatewayFailure` is also never called anywhere in the visible spec: dead code.
**Fix:** `handle_errors { header X-Rioko-Gateway-Error "upstream_{err.status_code}" ; respond "{err.status_code}" }`, and set the header on the 401/403 responses too. Then actually call `isGatewayFailure` — in `listLodgifyBookings` (`src/index.ts:2746`) and `liveFetchLodgifyBookings` (`src/handlers/reconciliation.ts:287`), so a gateway 502/403 does not get retried four times as if it were a Lodgify rate limit.

**10. A gateway 403 (wrong secret, un-allowlisted path) becomes "this account has no bookings" on the Conciliação page.**
`src/handlers/reconciliation.ts:305-317`: any non-429 non-OK breaks the retry loop, then `if (pageItems == null) break;` returns whatever was accumulated — possibly `[]` — and the caller renders it. This is the same phantom class recorded in the user's notes ("uncapped proxy reads faked 'Sem fatura'"). Adding a new 403-emitting hop in front makes it far more likely.
**Fix:** make `liveFetchLodgifyBookings` throw on a page-0 failure exactly as `listLodgifyBookings` already does (`src/index.ts:2782-2786` has the correct comment and behaviour), and surface it as an error state in the UI, not an empty list.

**11. Nothing checks that the proxy is alive; detection is inferred from ingestion staleness with a ≥6h floor and a daily bucket.**
`src/index.ts:3532` uses `staleMs = 6h`, only runs in the 08:00 cron, and the incident is `bucket: "daily"`. The 30-min cron's own failure path is `catch (e) { console.error(...) }` (`src/index.ts:3592`) — console only. If the VPS dies Saturday 23:00, first alert is Sunday 08:00. That is exactly how the Vercel feeder failed silently.
**Fix:** add a `/healthz` on Caddy (`respond 200`, no secret required, no upstream call) and probe it from the existing `*/30` cron before polling; on failure `reportIncident` with `severity: "critical"`, `bucket` finer than daily, and a summary naming the proxy. Cost: one `fetch` every 30 minutes.

**12. Every "Lodgify blocked us" alert still tells Pedro to go register at lodgify.com/partners.**
`src/index.ts:3355` and `src/index.ts:3365` hardcode *"Nenhuma reserva pode ser sincronizada até registar em lodgify.com/partners"*. After the gateway, a 429-with-block-body means **the allowlisted IP got re-blocked** — a completely different, much more urgent remedy (stop all polling, mail Matthew, do not rotate IPs). An alert that names the wrong action is worse than none.
**Fix:** branch the copy on `resolveLodgifyGateway(env).relayed` and name the proxy IP and the "stop polling immediately" instruction.

---

## MEDIUM

**13. The 20-connected-user ceiling is a hard capacity limit and neither design guards it.**
Matthew's "the limit at the moment is 20 connected users" is the whole reason we were blocked; a static IP does not raise it. There are currently a handful of Lodgify connections, but nothing stops the 21st onboarding from re-tripping the same heuristic from the new IP, and then the allowlist itself is the thing that gets revoked.
**Fix:** a check in the 08:00 cron: `SELECT COUNT(*) FROM connections WHERE source_kind='lodgify' AND status='active'`; warn at 15, refuse to activate at 20 in the backoffice wizard with copy pointing to partner registration. And keep partner registration as the actual roadmap item — the proxy is a tourniquet, and the runbook should say so in its first paragraph rather than reading like a solution.

**14. The runbook explicitly rejects rate limiting, but our own traffic is the re-block risk, not scanners.**
Pacing today is per-call-site and uncoordinated: `listLodgifyBookings` sleeps 250ms between pages (`src/index.ts:2795`), `liveFetchLodgifyBookings` sleeps 250ms independently (`reconciliation.ts:315`), the 30-min cron iterates connections with no inter-connection delay, and `POST /admin/lodgify/poll` can run concurrently with the cron. A backfill or two operators loading Conciliação can burst 40 pages × N connections from the one IP Lodgify is watching. fail2ban-on-403 does nothing about traffic that carries a valid secret.
**Fix:** the proxy is the only global choke point — put the pacing there. If `xcaddy` is unwanted scope, a `Retry-After`-respecting token bucket is ~30 lines in front of `reverse_proxy`, or accept the `caddy-ratelimit` plugin build; either is smaller than the incident it prevents. At minimum, serialise: `transport http { max_conns_per_host 2 }` plus a documented global cap.

**15. The proxy hostname is public within minutes of issuing a certificate — "who learns the hostname" is "everyone".**
`lodgify-proxy.rioko.online` lands in Certificate Transparency logs the moment Caddy completes ACME. The runbook's threat model treats hostname discovery as the trigger for its controls, which is fine, but it should say plainly that the secret is the *only* control, because obscurity is zero. Also: the record must be **DNS-only (grey cloud)** on Cloudflare — an orange-clouded record breaks HTTP-01, hides the real IP behind Cloudflare, and can route the Worker's `fetch` back into the Cloudflare edge.
**Fix:** state grey-cloud explicitly; consider a non-obvious hostname *and* a `tls internal`-free but CT-aware posture; add Hetzner Cloud Firewall source restriction is impossible (Workers have no fixed source), so the secret must be ≥256 bits and rotated (see #16).

**16. No rotation procedure for the shared secret, and a single-valued matcher makes rotation an outage.**
Neither document says how to change `LODGIFY_GATEWAY_KEY`. With one accepted value, rotating means the proxy and the Worker are briefly disagreeing, and `wrangler secret put` + `wrangler deploy` is not atomic.
**Fix:** make the Caddy matcher accept either of two values (`@authed header X-Rioko-Gateway-Key {env.GW_KEY_A}` / `{env.GW_KEY_B}` in an OR'd `@` matcher), and document: set B on proxy → `wrangler secret put` B → drop A. Rotate on any Cloudflare-account access change.

**17. No egress restriction and no upstream TLS pinning statement.**
Hetzner outbound is left unrestricted. This box now holds, in flight, every merchant's Lodgify key and guest PII, and its IP is trusted by Lodgify. A compromise gets unrestricted egress from a reputable address.
**Fix:** ufw/nftables egress allow only 443/tcp to `api.lodgify.com` (resolve + refresh, or simply 443 out and 53 out, deny the rest). And state in the Caddyfile comment that `tls_insecure_skip_verify` is forbidden, and that no `tls_server_name` override is needed because the upstream is `https://api.lodgify.com`.

**18. No timeouts anywhere on the new hop.**
Only the backoffice sets an `AbortController` (8s). The Worker's Lodgify fetches have none, and `LodgifyFetchOpts.signal` in the spec has no default. `wrangler.jsonc` sets `cpu_ms: 60000` but wall-clock on a cron is finite, and a hung TCP connection to a dead VPS holds a subrequest far longer than a `fetch` to a healthy CDN would.
**Fix:** default `AbortSignal.timeout(15_000)` inside `lodgifyFetch`; on the Caddy side `transport http { dial_timeout 5s response_header_timeout 20s }`.

**19. GDPR/subprocessor record not updated.**
Guest names, postal addresses, emails and phone numbers (`fetchGuestDetails`, `lodgify-source.ts:472-500`) now transit a Hetzner box. Hetzner becomes a subprocessor for two paying clients' guest data.
**Fix:** sign the Hetzner DPA, add Hetzner to the merchant-facing subprocessor list, and record the box in whatever RoPA exists. One line in the runbook, one email to Origos and Overbuilding.

---

## LOW

**20. Caddy `{env.X}` empty-value semantics are worse than "fails open".**
The runbook flags the fail-open but the concrete behaviour matters: `header X-Rioko-Gateway-Key ""` in Caddy matches *presence of the field*, so an unset env var turns the check into "send any value for this header". A systemd `ExecStartPre=/usr/bin/test -n "${GW_KEY_A}"` plus `EnvironmentFile=` with `Restart=always` is the guard; verify with a deliberate empty-key boot in staging.

**21. Access-log deletion must be paired with "never enable `debug`".**
Caddy's global `debug` option logs full request context including headers, and its redaction list covers `Authorization`/`Cookie` only — not `X-ApiKey`. Add an explicit "do not enable `debug`, ever, on this host; reproduce problems with a throwaway key" line, and confirm `log { format json }` with `request>headers` deleted also applies to the error log, not just the access log.

**22. Recovery of the allowlist after a rebuild is one unstated checklist item from a re-outage.**
The runbook correctly says to keep the Primary IP on server delete. Add the inverse assertion to the runbook's verification section: after any rebuild, `curl -s ifconfig.me` from the box must equal the IP Lodgify allowlisted, in writing, in the ticket. And keep Matthew's confirmation email path in the repo, because the next person will not know which IP is blessed.
