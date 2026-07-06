import type {
  DestinationAdapter,
  AdapterCtx,
  DestinationInvoiceCreateResult,
  DestinationCreditResult,
  NormalizedRefund,
} from "../types";
import type { Normalized } from "../../api/normalize-shopify";
import { validatePTNIF } from "../../ix/nif";
import { reconcileTotalOrThrow } from "../reconcile";
import { redactSecrets } from "../../security";

/**
 * MoloniDestination
 *
 * Implements DestinationAdapter against Moloni's REST API v1
 * (https://www.moloni.pt/dev/). Mirrors the shape of the IX adapter so the
 * generic pipeline can swap destinations without code changes.
 *
 * NOTE: Token caching is intentionally NOT done here — each invocation fetches
 * a fresh OAuth token. Workers cold-starts make in-process caching unreliable,
 * and a shared KV/D1-backed token store should live at the infrastructure
 * layer (see TODO in coordinator notes). Per-request token cost is one extra
 * round-trip; acceptable until volume justifies a cache.
 */

type MoloniTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
};

type MoloniCustomerLookup = {
  customer_id: number;
  vat?: string;
  name?: string;
  email?: string;
};

type MoloniTaxLine = {
  tax_id: number;
  value: number;
  order: number;
  cumulative: 0 | 1;
};

type MoloniProductLine = {
  product_id?: number;
  name: string;
  summary?: string;
  qty: number;
  price: number;
  discount: number;
  order: number;
  exemption_reason?: string;
  taxes?: MoloniTaxLine[];
};

export type MoloniCfg = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  companyId: number;
  documentSetId: number;
  // Moloni account tax rule ID for the standard VAT rate (e.g. "IVA 23%").
  // 0 = resolve tax_id from the company's tax table by rate (see taxIdByRate).
  // Set moloni_default_tax_id in destinationConfig to pin a single rule.
  defaultTaxId: number;
  // Rate → Moloni tax_id, resolved from /taxes/getAll/ when defaultTaxId is 0.
  // Populated per createDraft/issueCredit; lets a company invoice at whatever
  // rate the line carries (e.g. 6% alojamento) without a per-client id in config.
  taxIdByRate?: Map<number, number>;
  // Human-readable names used for lazy ID resolution when IDs are absent.
  companyName?: string;
  documentSetName?: string;
  // "invoice" → /invoices/insert/ (default), "invoice_receipt" → /invoiceReceipts/insert/
  documentType: string;
};

const DEFAULT_PAYMENT_METHOD_ID = 0; // 0 = unset; finalize accepts no method
const NON_PT_GENERIC_VAT = "999999990";
const MOLONI_PT_COUNTRY_ID = 1; // Portugal is always 1 in Moloni's fixed seed data

// Module-level caches: survive within a single Worker isolate, flushed on cold start.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const countryCache = new Map<number, Map<string, number>>(); // companyId → ISO-2 → country_id
// Resolved IDs cache: avoids repeated company/document-set listing when IDs
// are absent from DB but names are stored (lazy-resolution path).
const resolvedIdCache = new Map<string, { companyId: number; documentSetId: number }>();

function readMoloniCfg(ctx: AdapterCtx): MoloniCfg {
  // Credentials live in `connections.destination_config_json` (Phase 5 storage).
  // Adapter falls back to the legacy `integrations` row only for the `ix_*`
  // behavior toggles that all destinations share (exemption_reason, etc.).
  const c = (ctx.destinationConfig ?? {}) as Record<string, string | number | null>;

  // Sandbox URL not documented in the current Moloni API reference. Historical
  // `apidemo.moloni.pt` may still respond but coordinator should verify with
  // live credentials before relying on it.
  const env = (c.moloni_environment ?? "production") === "sandbox"
    ? "https://apidemo.moloni.pt/v1"
    : "https://api.moloni.pt/v1";

  const clientId = String(c.moloni_client_id ?? "").trim();
  const clientSecret = String(c.moloni_client_secret ?? "").trim();
  const username = String(c.moloni_username ?? "").trim();
  const password = String(c.moloni_password ?? "").trim();
  const companyId = Number(c.moloni_company_id ?? 0);
  const documentSetId = Number(c.moloni_document_set_id ?? 0);
  const companyName = String(c.moloni_company_name ?? "").trim() || undefined;
  const documentSetName = String(c.moloni_document_set_name ?? "").trim() || undefined;

  if (!clientId || !clientSecret || !username || !password) {
    throw new Error("Moloni create failed: missing OAuth credentials (client_id/client_secret/username/password)");
  }

  const defaultTaxId = Number(c.moloni_default_tax_id ?? 0);
  const documentType = String(c.moloni_document_type ?? "invoice").toLowerCase();
  return { baseUrl: env, clientId, clientSecret, username, password, companyId, documentSetId, companyName, documentSetName, defaultTaxId, documentType };
}

/**
 * Exemption code for zero-VAT lines. Non-IX destinations (the Stripe/Lodgify→Moloni
 * setup wizards) store this in the connection's destination_config; the legacy
 * `integrations.ix_exemption_reason` is the fallback for IX-origin configs.
 */
function resolveExemptionReason(ctx: AdapterCtx): string {
  const fromDest = ctx.destinationConfig?.exemption_reason;
  const raw = typeof fromDest === "string" && fromDest.trim()
    ? fromDest
    : (ctx.config?.ix_exemption_reason ?? "M01");
  return String(raw).trim() || "M01";
}

// Resolves company/document-set names → IDs via Moloni API when IDs are absent.
// Uses module-level cache so resolution only happens once per cold start.
export async function getMoloniCfg(ctx: AdapterCtx): Promise<MoloniCfg> {
  const raw = readMoloniCfg(ctx);
  if (raw.companyId && raw.documentSetId) return raw;

  const cacheKey = `${raw.clientId}:${raw.username}:${raw.documentSetName ?? raw.documentSetId}`;
  const cached = resolvedIdCache.get(cacheKey);
  if (cached) return { ...raw, ...cached };

  let { companyId, documentSetId } = raw;

  const token = await getAccessToken(raw);

  if (!companyId) {
    if (!raw.companyName) throw new Error("Moloni: missing moloni_company_id and moloni_company_name");
    // companies/getAll requires POST with no body; Content-Type must be absent/empty or Apache 400s.
    const companiesRes = await fetch(
      `${raw.baseUrl}/companies/getAll/?access_token=${encodeURIComponent(token)}&json=true`,
      { method: "POST", headers: { "Accept": "application/json" } },
    );
    const companiesData: unknown[] = await safeJson(companiesRes) as unknown[];
    const list = Array.isArray(companiesData) ? companiesData : [];
    const match = list.find((c: any) => String(c.name ?? c.company_name ?? "").toLowerCase() === raw.companyName!.toLowerCase());
    if (!match) {
      const names = list.map((c: any) => `"${c.name ?? c.company_name}"`).join(", ");
      throw new Error(`Moloni: company "${raw.companyName}" not found. Available: ${names || "(none)"}`);
    }
    companyId = Number((match as any).company_id ?? (match as any).id);
  }

  if (!documentSetId) {
    // documentSets/getAll requires company_id as JSON body; form-encoded is ignored.
    const dsRes = await fetch(
      `${raw.baseUrl}/documentSets/getAll/?access_token=${encodeURIComponent(token)}&json=true`,
      { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" }, body: JSON.stringify({ company_id: companyId }) },
    );
    const dsData: unknown[] = await safeJson(dsRes) as unknown[];
    const dsList = Array.isArray(dsData) ? dsData : [];
    if (raw.documentSetName) {
      const dsMatch = dsList.find((d: any) => String(d.name ?? d.document_set_name ?? "").toLowerCase() === raw.documentSetName!.toLowerCase());
      if (!dsMatch) {
        const names = dsList.map((d: any) => `"${d.name ?? d.document_set_name}"`).join(", ");
        throw new Error(`Moloni: document set "${raw.documentSetName}" not found. Available: ${names || "(none)"}`);
      }
      documentSetId = Number((dsMatch as any).document_set_id ?? (dsMatch as any).id);
    } else {
      // No série specified → use the account's default set (active_by_default),
      // falling back to the first available set.
      const def = dsList.find((d: any) => Number((d as any).active_by_default) === 1) ?? dsList[0];
      if (!def) throw new Error("Moloni: no document set available for this company — create a série in Moloni or name one explicitly.");
      documentSetId = Number((def as any).document_set_id ?? (def as any).id);
    }
  }

  resolvedIdCache.set(cacheKey, { companyId, documentSetId });
  return { ...raw, companyId, documentSetId };
}

export async function getAccessToken(cfg: MoloniCfg): Promise<string> {
  const cacheKey = `${cfg.clientId}:${cfg.username}`;
  const cached = tokenCache.get(cacheKey);
  // Evict 60 s before actual expiry to avoid races at the token boundary.
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const url = new URL(`${cfg.baseUrl}/grant/`);
  url.searchParams.set("grant_type", "password");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("client_secret", cfg.clientSecret);
  url.searchParams.set("username", cfg.username);
  url.searchParams.set("password", cfg.password);

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Accept": "application/json" },
  });
  const body = await safeJson(res);
  if (!res.ok) {
    throw new Error(`Moloni create failed: auth ${res.status} — ${safeErrorJson(body)}`);
  }
  const token = (body as MoloniTokenResponse)?.access_token;
  if (!token) {
    throw new Error(`Moloni create failed: auth returned no access_token — ${safeErrorJson(body)}`);
  }
  const expiresIn = (body as MoloniTokenResponse)?.expires_in ?? 3600;
  tokenCache.set(cacheKey, { token, expiresAt: Date.now() + expiresIn * 1000 });
  return token;
}

// Moloni API rejects JSON bodies with `Forbidden, No company_id received`. It
// only accepts application/x-www-form-urlencoded with PHP-style bracket
// nesting for arrays/objects (e.g. `products[0][name]=foo&products[0][taxes][0][tax_id]=123`).
function formEncode(obj: Record<string, unknown>, prefix = ""): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        const idxKey = `${key}[${i}]`;
        if (item !== null && typeof item === "object") {
          parts.push(formEncode(item as Record<string, unknown>, idxKey));
        } else {
          parts.push(`${encodeURIComponent(idxKey)}=${encodeURIComponent(String(item))}`);
        }
      });
    } else if (typeof v === "object") {
      parts.push(formEncode(v as Record<string, unknown>, key));
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.filter(Boolean).join("&");
}

export async function moloniCall<T = unknown>(
  cfg: MoloniCfg,
  token: string,
  path: string,
  body: Record<string, unknown>,
  opName: "create" | "finalize" | "credit create" | "email" | "lookup",
): Promise<T> {
  const url = `${cfg.baseUrl}${path}?access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body: formEncode({ company_id: cfg.companyId, ...body }),
  });
  const json = await safeJson(res);
  if (!res.ok) {
    // Moloni returns 401 on expired tokens — propagate so the error classifier
    // in generic-pipeline tags it as auth_failure_destination.
    throw new Error(`Moloni ${opName} failed: ${res.status} — ${safeErrorJson(json)}`);
  }
  // Moloni often returns `{valid: 1, ...}` on success; `{valid: 0, errors: ...}`
  // on logical failure (e.g. invalid NIF). Treat both 200+valid:0 as errors.
  if (json && typeof json === "object" && "valid" in (json as object) && (json as { valid: number }).valid === 0) {
    throw new Error(`Moloni ${opName} failed: ${safeErrorJson(json)}`);
  }
  // Moloni surfaces field-validation errors as a 200-OK body containing
  // a plain array of strings like `["1 products", "2 customer_id 1 0"]`.
  // /products/getByReference/ legitimately returns `[]` on no-match (length 0),
  // but a non-empty array of plain strings is always a validation failure.
  if (
    Array.isArray(json)
    && json.length > 0
    && json.every((entry) => typeof entry === "string")
  ) {
    throw new Error(`Moloni ${opName} failed: validation errors ${safeErrorJson(json)}`);
  }
  return json as T;
}

// Distinguish transient Moloni failures (5xx, network, timeout) from genuine
// "not found" misses. Swallowing a 5xx during a lookup made the code fall
// through to INSERT — creating duplicate customer/product/invoice records
// during Moloni outages. Re-throwing 5xx lets the queue retry; 4xx/validation
// errors keep their "treat as miss" behaviour.
function isMoloniTransient(e: unknown): boolean {
  if (!e) return false;
  const msg = String((e as { message?: string })?.message ?? e).toLowerCase();
  if (msg.includes("timeout") || msg.includes("network") || msg.includes("fetch failed")) return true;
  // moloniCall throws "Moloni ${opName} failed: ${status} — …" on !res.ok.
  // 401/403/404/422 → caller decides; 5xx → transient.
  const m = msg.match(/moloni [a-z ]+ failed: (\d{3})/);
  if (m) {
    const status = Number(m[1]);
    return status >= 500 && status <= 599;
  }
  return false;
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    try {
      const text = await res.text();
      return { _nonJson: true, text };
    } catch {
      return { _nonJson: true };
    }
  }
}

function truncate(s: string, max = 500): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// Stringify error payloads with credential redaction. Moloni's auth + API
// responses can echo request fields back; redactSecrets strips known-sensitive
// keys (client_secret, password, access_token, …) before they hit error
// messages, queue logs, or D1 dev_logs.
function safeErrorJson(value: unknown, max = 500): string {
  return truncate(JSON.stringify(redactSecrets(value)), max);
}

function isPortugal(countryCode: string | null | undefined): boolean {
  return String(countryCode ?? "").trim().toUpperCase() === "PT";
}

// Extracts a 9-digit PT NIF candidate from the same fields IX's builder reads.
// Pared down from IxBuilder.extractAndValidateNIF — we only need a yes/no PT
// fiscal id here, the heavy EU-VAT shape work is owned by IX.
function extractPtNif(normalized: Normalized): string | null {
  const candidates: string[] = [];
  const order = normalized.order;

  if (Array.isArray(order.note_attributes)) {
    const keywords = ["nif", "vat", "contribuinte", "fiscal", "tax"];
    for (const attr of order.note_attributes as Array<{ name?: string; value?: unknown }>) {
      if (!attr || attr.value == null) continue;
      const name = String(attr.name ?? "").toLowerCase().replace(/\s+/g, "");
      const value = String(attr.value);
      if (keywords.some((k) => name.includes(k))) {
        const clean = value.replace(/\D/g, "");
        if (clean.length >= 9) candidates.push(clean.slice(-9));
      } else {
        const matches = value.match(/\b\d{9}\b/g);
        if (matches) candidates.push(...matches);
      }
    }
  }

  if (order.note) {
    const matches = String(order.note).match(/\b\d{9}\b/g);
    if (matches) candidates.push(...matches);
  }

  const billing = order.billing_address;
  if (billing) {
    if (billing.company) {
      const m = billing.company.match(/\b\d{9}\b/g);
      if (m) candidates.push(...m);
    }
    if (billing.address2) {
      const m = billing.address2.match(/\b\d{9}\b/g);
      if (m) candidates.push(...m);
    }
  }

  for (const n of candidates) {
    if (validatePTNIF(n)) return n;
  }
  return null;
}

// Resolve Moloni's internal country_id from an ISO-3166-1-alpha-2 code.
// PT is always 1 in Moloni's seed. Other codes are lazily fetched from
// /countries/getAll/ and cached per companyId for the Worker isolate lifetime.
// Falls back to PT if absent or not found.
async function resolveCountryId(
  cfg: MoloniCfg,
  token: string,
  isoCode: string | null | undefined,
): Promise<number> {
  const iso = String(isoCode ?? "").trim().toUpperCase();
  if (!iso || iso === "PT") return MOLONI_PT_COUNTRY_ID;

  let companyCountries = countryCache.get(cfg.companyId);
  if (!companyCountries) {
    companyCountries = new Map<string, number>();
    countryCache.set(cfg.companyId, companyCountries);
  }
  if (companyCountries.has(iso)) return companyCountries.get(iso)!;

  // Populate cache by fetching the full country list once per Worker lifetime.
  try {
    const list = await moloniCall<Array<{ country_id?: number; iso_3166_1?: string }>>(
      cfg, token, "/countries/getAll/", {}, "lookup",
    );
    if (Array.isArray(list)) {
      for (const entry of list) {
        const code = String(entry.iso_3166_1 ?? "").trim().toUpperCase();
        if (code && entry.country_id) companyCountries.set(code, Number(entry.country_id));
      }
    }
  } catch {
    // Non-fatal: unknown code falls back to PT.
  }

  return companyCountries.get(iso) ?? MOLONI_PT_COUNTRY_ID;
}

function taxRateForItem(
  item: Normalized["order"]["items"][number],
  ctx: AdapterCtx,
): number {
  // Shipping iff no SKU AND no product/variant id — same rule as
  // deriveProductReference. force_shipping_tax_rate only applies to
  // genuine shipping lines, not Stripe synthetic items with a price id.
  const sku = (item.sku ?? "").trim();
  const isShipping = !sku && !item.product_id && !item.variant_id;
  const forceTax = isShipping
    ? ctx.config.force_shipping_tax_rate
    : ctx.config.force_tax_rate;
  if (forceTax != null) return Number(forceTax);
  return item.tax.unit_amount === 0 ? 0 : Number(item.tax.value);
}

// companyId → (rate → tax_id), from /taxes/getAll/. Survives within an isolate.
const taxRateToIdCache = new Map<number, Map<number, number>>();

function normRate(rate: number): number {
  return Math.round(Number(rate) * 100) / 100;
}

// Pick the Moloni tax_id for a given rate. Explicit moloni_default_tax_id wins
// (back-compat with connections that pin one rule). Otherwise use the rate→id
// map resolved from the company's tax table. Throws with an actionable message
// rather than silently emitting tax_id:0 (which Moloni rejects).
function pickTaxId(cfg: MoloniCfg, rate: number): number {
  if (cfg.defaultTaxId > 0) return cfg.defaultTaxId;
  const id = cfg.taxIdByRate?.get(normRate(rate));
  if (id && id > 0) return id;
  const known = cfg.taxIdByRate ? [...cfg.taxIdByRate.keys()].join(", ") : "(none)";
  throw new Error(
    `Moloni: company ${cfg.companyId} has no IVA tax rule at ${rate}% (available: ${known}). ` +
    `Set moloni_default_tax_id in the connection or create a ${rate}% tax in Moloni.`,
  );
}

// Resolve the tax_id for every distinct positive rate the order needs and stash
// the map on cfg for buildMoloniLineItems / ensureMoloniProduct to read. No-op
// when moloni_default_tax_id is set (explicit override) or all lines are exempt.
// Fails fast if a required rate has no matching tax rule in the company.
async function ensureTaxIdsByRate(cfg: MoloniCfg, token: string, rates: number[]): Promise<void> {
  if (cfg.defaultTaxId > 0) return;
  const wanted = [...new Set(rates.map(normRate).filter((r) => r > 0))];
  if (wanted.length === 0) return;

  let map = taxRateToIdCache.get(cfg.companyId);
  if (!map) {
    const taxes = await moloniCall<Array<{ tax_id?: number; value?: number | string }>>(
      cfg, token, "/taxes/getAll/", {}, "lookup",
    );
    map = new Map<number, number>();
    if (Array.isArray(taxes)) {
      for (const t of taxes) {
        const val = normRate(Number(t.value));
        const id = Number(t.tax_id);
        // First rule per rate wins (Moloni lists the primary first).
        if (id > 0 && Number.isFinite(val) && !map.has(val)) map.set(val, id);
      }
    }
    taxRateToIdCache.set(cfg.companyId, map);
  }
  cfg.taxIdByRate = map;

  for (const r of wanted) {
    if (!map.get(r)) {
      throw new Error(
        `Moloni: company ${cfg.companyId} has no IVA tax rule at ${r}% ` +
        `(available: ${[...map.keys()].join(", ") || "none"}). Set moloni_default_tax_id.`,
      );
    }
  }
}

// A resolved Moloni product for one order-line reference. `mapped` marks
// references the merchant explicitly linked in /integrations/moloni-mappings —
// for those we honour the Moloni product's OWN tax rule (taxes/exemption read
// via /products/getOne/), so mixed-rate invoices are driven by the mapping.
// Unmapped references keep the source-derived rate (taxRateForItem).
type ResolvedProduct = {
  product_id: number;
  mapped: boolean;
  taxes?: MoloniTaxLine[];
  exemption_reason?: string;
};

// companyId:product_id → the mapped product's own tax rule, read once per isolate.
const productTaxCache = new Map<string, { taxes?: MoloniTaxLine[]; exemption_reason?: string }>();

// Read a mapped Moloni product's own taxes[] + exemption_reason via
// /products/getOne/. Moloni lines cannot inherit a product's tax — each must
// declare taxes[] or exemption_reason — so we copy the product's rule onto the
// line. Cached per isolate; transient 5xx re-throws so the queue retries.
async function fetchMoloniProductTax(
  cfg: MoloniCfg,
  token: string,
  productId: number,
): Promise<{ taxes?: MoloniTaxLine[]; exemption_reason?: string }> {
  const key = `${cfg.companyId}:${productId}`;
  const cached = productTaxCache.get(key);
  if (cached) return cached;

  const prod = await moloniCall<{
    // On a product tax association the RATE lives in the nested `tax.value`; the
    // outer `value` is a per-product override that Moloni leaves 0 by default.
    taxes?: Array<{ tax_id?: number; value?: number | string; order?: number; cumulative?: number; tax?: { value?: number | string; exemption_reason?: string } }>;
    exemption_reason?: string;
  }>(cfg, token, "/products/getOne/", { product_id: productId }, "lookup");

  const taxes: MoloniTaxLine[] = Array.isArray(prod?.taxes)
    ? prod!.taxes
        .filter((t) => Number(t?.tax_id) > 0)
        .map((t, i) => {
          const rate = Number(t.tax?.value ?? 0) > 0 ? Number(t.tax?.value) : Number(t.value ?? 0);
          return {
            tax_id: Number(t.tax_id),
            value: normRate(rate),
            order: Number(t.order ?? i + 1),
            cumulative: (Number(t.cumulative) === 1 ? 1 : 0) as 0 | 1,
          };
        })
    : [];
  const result = taxes.length > 0
    ? { taxes }
    : { exemption_reason: (prod?.exemption_reason ?? "").toString().trim() || undefined };
  productTaxCache.set(key, result);
  return result;
}

// True when the merchant explicitly mapped this line's reference to a Moloni
// product (so the product's own tax rule wins over the source-derived rate).
function isReferenceMapped(ctx: AdapterCtx, item: Normalized["order"]["items"][number]): boolean {
  const pid = ctx.productMappings?.get(deriveProductReference(item));
  return pid != null && Number.isFinite(pid) && Number(pid) > 0;
}

// ── Multi-currency ────────────────────────────────────────────────────────────
// companyId → iso4217 → currency_id, and the daily EUR conversion table. Both
// survive within an isolate (Moloni refreshes the exchange table daily; the
// short isolate lifetime keeps us well inside that window).
const currencyIdCache = new Map<number, Map<string, number>>();
const currencyExchangeCache = new Map<number, Array<{ from: number; to: number; value: number }>>();
const MOLONI_BASE_CURRENCY = "EUR";

type MoloniExchange = { currencyId: number; rate: number };

// Resolve exchange_currency_id + exchange_rate for a non-EUR document so Moloni
// issues in the paid currency (native support). Returns null for EUR/empty.
// exchange_rate = EUR-per-1-foreign — the value of the currencyExchange record
// with from=foreign,to=EUR (inverted from the reverse record when only that
// exists). Validated against live data (currencies: EUR=1,USD=2; exchange
// USD->EUR=0.87355 = EUR per USD). Still logged so the first real finalized doc
// can confirm the EUR fiscal total matches.
async function resolveMoloniExchange(
  cfg: MoloniCfg,
  token: string,
  isoCurrency: string | null | undefined,
): Promise<MoloniExchange | null> {
  const iso = String(isoCurrency ?? "").trim().toUpperCase();
  if (!iso || iso === MOLONI_BASE_CURRENCY) return null;

  // 1. iso4217 → currency_id (foreign + EUR), cached per company.
  let idByIso = currencyIdCache.get(cfg.companyId);
  if (!idByIso) {
    const list = await moloniCall<Array<{ currency_id?: number; iso4217?: string }>>(
      cfg, token, "/currencies/getAll/", {}, "lookup",
    );
    idByIso = new Map<string, number>();
    if (Array.isArray(list)) {
      for (const c of list) {
        const code = String(c?.iso4217 ?? "").trim().toUpperCase();
        if (code && Number(c?.currency_id) > 0) idByIso.set(code, Number(c.currency_id));
      }
    }
    currencyIdCache.set(cfg.companyId, idByIso);
  }
  const foreignId = idByIso.get(iso);
  const eurId = idByIso.get(MOLONI_BASE_CURRENCY);
  if (!foreignId || !eurId) {
    throw new Error(`Moloni create failed: currency ${iso} has no Moloni currency_id (available: ${[...idByIso.keys()].join(", ") || "none"})`);
  }

  // 2. Daily exchange table (no params), cached per company/isolate.
  let table = currencyExchangeCache.get(cfg.companyId);
  if (!table) {
    const rows = await moloniCall<Array<{ from?: number; to?: number; value?: number | string }>>(
      cfg, token, "/currencyExchange/getAll/", {}, "lookup",
    );
    table = (Array.isArray(rows) ? rows : []).map((r) => ({ from: Number(r.from), to: Number(r.to), value: Number(r.value) }));
    currencyExchangeCache.set(cfg.companyId, table);
  }

  // Prefer the foreign→EUR record (value = EUR per 1 foreign); fall back to the
  // inverse EUR→foreign record and invert. Throw if neither exists.
  const fwd = table.find((r) => r.from === foreignId && r.to === eurId && r.value > 0);
  const rev = table.find((r) => r.from === eurId && r.to === foreignId && r.value > 0);
  const rate = fwd ? fwd.value : rev ? Math.round((1 / rev.value) * 1e6) / 1e6 : 0;
  if (!(rate > 0)) {
    throw new Error(`Moloni create failed: no ${iso}/EUR exchange rate in Moloni's daily table`);
  }
  console.log(`[Moloni] currency ${iso}: exchange_currency_id=${foreignId} exchange_rate=${rate} (fwd=${fwd?.value ?? "-"} rev=${rev?.value ?? "-"})`);
  return { currencyId: foreignId, rate };
}

function buildMoloniLineItems(
  normalized: Normalized,
  ctx: AdapterCtx,
  resolved: Map<string, ResolvedProduct>,
  cfg: MoloniCfg,
): MoloniProductLine[] {
  return normalized.order.items.map((item, idx): MoloniProductLine => {
    const reference = deriveProductReference(item);
    const resolvedProduct = resolved.get(reference);
    if (!resolvedProduct?.product_id) {
      throw new Error(`Moloni create failed: no Moloni product_id resolved for reference '${reference}'`);
    }
    const name = deriveProductName(item);
    const sku = (item.sku ?? "").trim();
    // Show SKU on the line whenever it's present (Shopify variant SKU,
    // Stripe price id, etc). Genuine Shopify shipping lines have no SKU
    // so they fall through to undefined.
    const summary = sku ? `SKU: ${sku}`.slice(0, 200) : undefined;

    // Moloni `price` is the NET unit price (VAT-exclusive); Moloni adds tax
    // on top from `taxes[].value`. This matches the IX convention for
    // `normalized.unit_price` (NET — see IxBuilder.buildInvoiceItems), so we
    // pass through directly. If a source adapter ever emits a gross unit_price
    // with a non-zero tax_rate, the reconcileTotalOrThrow check in createDraft
    // will catch the drift before the invoice is posted.
    const netUnit = Math.round(item.unit_price * 10000) / 10000;
    const discountPct = item.discount?.percent ?? 0;

    const line: MoloniProductLine = {
      product_id: resolvedProduct.product_id,
      name,
      qty: item.quantity,
      price: netUnit,
      discount: discountPct,
      order: idx + 1,
    };
    if (summary) line.summary = summary;

    if (resolvedProduct.mapped) {
      // Mapped reference: the Moloni product's OWN tax rule drives the line.
      // This is what makes mixed-rate invoices work — map a 6% product and a
      // 23% product and the invoice carries both rates.
      if (resolvedProduct.taxes && resolvedProduct.taxes.length > 0) {
        line.taxes = resolvedProduct.taxes.map((t, i) => ({ ...t, order: i + 1 }));
      } else {
        line.exemption_reason = resolvedProduct.exemption_reason || resolveExemptionReason(ctx);
      }
      return line;
    }

    // Unmapped reference: derive the rate from the source (or force_tax_rate).
    const taxRate = taxRateForItem(item, ctx);
    if (taxRate > 0) {
      line.taxes = [{ tax_id: pickTaxId(cfg, taxRate), value: taxRate, order: 1, cumulative: 0 }];
    } else {
      // Exemption code required by Moloni on zero-tax lines.
      line.exemption_reason = resolveExemptionReason(ctx);
    }
    return line;
  });
}

async function resolveOrCreateCustomer(
  cfg: MoloniCfg,
  token: string,
  normalized: Normalized,
): Promise<number> {
  const order = normalized.order;
  const billing = order.billing_address;
  const ptNif = extractPtNif(normalized);
  const countryIsPT = isPortugal(billing?.country_code);
  const vat = countryIsPT && ptNif ? ptNif : NON_PT_GENERIC_VAT;

  // Compute name early so we can decide whether to skip the VAT lookup.
  const customerName = (order.customer?.name?.trim() || billing?.name?.trim() || "Consumidor Final").slice(0, 200);

  // 1. Lookup by VAT — but skip when using the generic consumer VAT and we have
  // a real guest name. The generic VAT matches the shared "Consumidor Final"
  // account and we'd return that record instead of creating a named customer.
  const skipVatLookup = vat === NON_PT_GENERIC_VAT && customerName !== "Consumidor Final";
  if (!skipVatLookup) {
    try {
      const found = await moloniCall<MoloniCustomerLookup[] | MoloniCustomerLookup>(
        cfg, token, "/customers/getByVat/", { vat }, "lookup",
      );
      const first = Array.isArray(found) ? found[0] : found;
      if (first && typeof first === "object" && "customer_id" in first && first.customer_id) {
        return Number(first.customer_id);
      }
    } catch (e) {
      // Re-throw transient (5xx, network) so the queue retries instead of
      // silently inserting a duplicate customer. Genuine misses fall through.
      if (isMoloniTransient(e)) throw e;
    }
  }

  // 2. Insert a new customer record.
  // Moloni rejects number=0; fetch the next auto-assigned sequential number.
  const nextNumRes = await moloniCall<{ number?: string | number }>(
    cfg, token, "/customers/getNextNumber/", {}, "lookup",
  );
  // Guard non-numeric responses: some accounts return a corrupted sequence
  // (e.g. "NaN1"), and `Number()` would yield NaN → Moloni rejects "4 number"
  // AND persists a customer with a NaN number, corrupting the sequence further.
  // Fall back to a always-valid, non-colliding value.
  const parsedNext = Number(nextNumRes?.number);
  const nextNumber = Number.isFinite(parsedNext) && parsedNext > 0 ? parsedNext : Date.now();

  const countryId = await resolveCountryId(cfg, token, billing?.country_code);
  const inserted = await moloniCall<{ customer_id?: number }>(
    cfg, token, "/customers/insert/",
    {
      number: nextNumber,
      vat,
      name: customerName,
      language_id: 1,
      address: (billing?.address1 ?? "").slice(0, 200),
      city: (billing?.city ?? "").slice(0, 50),
      zip_code: (billing?.zip ?? "").slice(0, 20),
      country_id: countryId,
      email: (order.customer?.email ?? "").slice(0, 200),
      phone: ((order.customer as { phone?: string | null } | undefined)?.phone ?? billing?.phone ?? "").toString().slice(0, 50),
      maturity_date_id: 0,
      payment_day: 0,
      payment_method_id: DEFAULT_PAYMENT_METHOD_ID,
      delivery_method_id: 0,
      discount: 0,
      credit_limit: 0,
      salesman_id: 0,
      field_notes: "",
    },
    "lookup",
  );
  const customerId = inserted?.customer_id;
  if (!customerId) {
    throw new Error(`Moloni create failed: customer insert returned no id — ${safeErrorJson(inserted)}`);
  }
  return Number(customerId);
}

// Moloni rejects invoice lines without a valid `product_id` (returns the terse
// `["1 products"]` validation error). We can't create products inline in
// /invoices/insert/ — only references to existing product rows are accepted.
//
// Strategy: mirror the source product catalog. For each normalized item we
// derive a stable reference from the Shopify SKU / variant_id / product_id
// (or Stripe price/product id) and find-or-create a Moloni product row with
// that reference. Future invoices for the same SKU reuse the existing Moloni
// product — no per-invoice product clutter, real product titles in Moloni.
//
// Fallbacks (in order):
//   1. item.sku                      → reference = SKU verbatim (uppercased)
//   2. item.variant_id               → "RIOKO-VARIANT-<id>"
//   3. item.product_id               → "RIOKO-PRODUCT-<id>"
//   4. shipping line (no ids)        → "RIOKO-SHIPPING"
//   5. completely synthetic line     → "RIOKO-PLACEHOLDER"
const FALLBACK_PLACEHOLDER_REFERENCE = "RIOKO-PLACEHOLDER";
const SHIPPING_REFERENCE = "RIOKO-SHIPPING";

function deriveProductReference(item: Normalized["order"]["items"][number]): string {
  // SKU wins regardless of product_id/variant_id: Stripe-source items emit
  // sku=price_xxx with product_id=0/variant_id=0, and we want the mapping key
  // to be `price_xxx`, not RIOKO-SHIPPING. Shopify shipping lines have no SKU,
  // so they still fall into the SHIPPING_REFERENCE branch below.
  const sku = (item.sku ?? "").trim();
  if (sku) return sku.slice(0, 30); // Moloni caps reference at 30 chars
  if (!item.product_id && !item.variant_id) return SHIPPING_REFERENCE;
  if (item.variant_id) return `RIOKO-VARIANT-${item.variant_id}`.slice(0, 30);
  if (item.product_id) return `RIOKO-PRODUCT-${item.product_id}`.slice(0, 30);
  return FALLBACK_PLACEHOLDER_REFERENCE;
}

function deriveProductName(item: Normalized["order"]["items"][number]): string {
  // Shipping iff no SKU AND no product/variant id (a Shopify shipping_lines
  // row). Stripe items have sku=price_xxx so they don't trip this branch.
  const sku = (item.sku ?? "").trim();
  const isShipping = !sku && !item.product_id && !item.variant_id;
  if (isShipping) {
    return `Portes de envio${item.title ? ` — ${item.title}` : ""}`.slice(0, 200);
  }
  if (item.variant_title) {
    return `${item.title} / ${item.variant_title}`.slice(0, 200);
  }
  return (item.title ?? "Item").slice(0, 200);
}

async function ensureMoloniProduct(
  cfg: MoloniCfg,
  token: string,
  reference: string,
  defaultName: string,
  taxRate: number,
): Promise<number> {
  // 1. Look up by reference (exact match endpoint).
  try {
    const found = await moloniCall<Array<{ product_id?: number; reference?: string }>>(
      cfg, token, "/products/getByReference/",
      { reference },
      "lookup",
    );
    const match = Array.isArray(found) ? found[0] : null;
    if (match?.product_id) return Number(match.product_id);
  } catch (e) {
    // Re-throw transient so the queue retries instead of creating a duplicate
    // product. Genuine misses fall through to the create branch below.
    if (isMoloniTransient(e)) throw e;
  }

  // 2. Resolve a category_id + unit_id (required to create a product).
  const categories = await moloniCall<Array<{ category_id?: number }>>(
    cfg, token, "/productCategories/getAll/",
    { parent_id: 0 },
    "lookup",
  );
  const categoryId = Array.isArray(categories) ? categories[0]?.category_id : undefined;
  if (!categoryId) {
    throw new Error(`Moloni create failed: no product category available to host product '${reference}'`);
  }
  const units = await moloniCall<Array<{ unit_id?: number }>>(
    cfg, token, "/measurementUnits/getAll/", {}, "lookup",
  );
  const unitId = Array.isArray(units) ? units[0]?.unit_id : undefined;
  if (!unitId) {
    throw new Error(`Moloni create failed: no measurement unit available to host product '${reference}'`);
  }

  // 3. Create the product. `price: 0` because the real price is set per
  //    invoice line; Moloni only uses the master price as a default.
  //
  //    Moloni requires exemption_reason at the PRODUCT level (not just the
  //    invoice line) whenever no `taxes[]` row is provided. Default to M01;
  //    the per-invoice line exemption_reason still overrides if needed.
  const insertBody: Record<string, unknown> = {
    category_id: categoryId,
    unit_id: unitId,
    type: 1,
    name: defaultName,
    reference,
    price: 0,
    has_stock: 0,
  };
  if (taxRate > 0) {
    insertBody.taxes = [{ tax_id: pickTaxId(cfg, taxRate), value: taxRate, order: 0, cumulative: 0 }];
  } else {
    insertBody.exemption_reason = "M01";
  }
  const created = await moloniCall<{ product_id?: number }>(
    cfg, token, "/products/insert/", insertBody, "create",
  );
  if (!created?.product_id) {
    throw new Error(`Moloni create failed: product '${reference}' insert returned no id — ${safeErrorJson(created)}`);
  }
  return Number(created.product_id);
}

// Resolve every line's Moloni product for the normalized order. De-duplicates
// by reference so repeated SKUs share a single lookup/insert per createDraft
// call. Returns a Map<reference → ResolvedProduct>.
//
// Resolution order per reference:
//   1. Explicit user mapping from `ctx.productMappings` (set via the
//      /integrations/moloni-mappings backoffice page). For these we ALSO read
//      the Moloni product's own tax rule (via /products/getOne/) so the mapped
//      product's VAT drives the line — this is how mixed-rate invoices work.
//   2. find-or-create on Moloni's product catalog via ensureMoloniProduct,
//      using the source-derived rate.
async function resolveProducts(
  cfg: MoloniCfg,
  token: string,
  items: Normalized["order"]["items"],
  taxRateFor: (item: Normalized["order"]["items"][number]) => number,
  explicitMappings?: Map<string, number>,
): Promise<Map<string, ResolvedProduct>> {
  const byReference = new Map<string, { name: string; taxRate: number }>();
  for (const item of items) {
    const ref = deriveProductReference(item);
    if (!byReference.has(ref)) {
      byReference.set(ref, { name: deriveProductName(item), taxRate: taxRateFor(item) });
    }
  }
  const resolved = new Map<string, ResolvedProduct>();
  for (const [reference, meta] of byReference) {
    const mapped = explicitMappings?.get(reference);
    if (mapped && Number.isFinite(mapped) && mapped > 0) {
      const tax = await fetchMoloniProductTax(cfg, token, Number(mapped));
      resolved.set(reference, { product_id: Number(mapped), mapped: true, taxes: tax.taxes, exemption_reason: tax.exemption_reason });
      continue;
    }
    const pid = await ensureMoloniProduct(cfg, token, reference, meta.name, meta.taxRate);
    resolved.set(reference, { product_id: pid, mapped: false });
  }
  return resolved;
}

function todayYmd(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function dateOnlyYmd(input: string): string {
  // normalized.created_at is ISO-8601. Moloni wants YYYY-MM-DD.
  const m = input.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : todayYmd();
}

export class MoloniDestination implements DestinationAdapter {
  readonly kind = "moloni" as const;

  async findByReference(reference: string, ctx: AdapterCtx): Promise<{ id: string } | null> {
    const cfg = await getMoloniCfg(ctx);
    const token = await getAccessToken(cfg);
    try {
      // CRITICAL: query the SAME document type the reference was written to.
      // Refund references ("OrderRefund #<id>") live on CREDIT NOTES, not
      // invoices — searching /invoices/ for them made refund dedup blind and
      // duplicated the credit note on every webhook re-delivery. Invoice
      // references ("Order #<n>") match the invoice (or invoiceReceipt) drafts.
      // `our_reference` is the field Moloni indexes for free-text lookup and it
      // matches draft documents (status 0, number -1) too.
      const isCreditRef = /^OrderRefund /i.test(reference);
      const getAllPath = isCreditRef
        ? "/creditNotes/getAll/"
        : cfg.documentType === "invoice_receipt"
          ? "/invoiceReceipts/getAll/"
          : "/invoices/getAll/";
      const found = await moloniCall<Array<{ document_id?: number; our_reference?: string }>>(
        cfg, token, getAllPath, {
          document_set_id: cfg.documentSetId,
          our_reference: reference,
        },
        "lookup",
      );
      // Defensive exact match: Moloni's getAll filters by our_reference, but we
      // re-check client-side so a loose/ignored filter can never return a
      // false-positive — which for the refund path would SKIP (drop) a
      // legitimate credit note, a worse fault than a duplicate.
      const match = (Array.isArray(found) ? found : []).find(
        (d) => String(d.our_reference ?? "") === reference,
      );
      if (match?.document_id) return { id: String(match.document_id) };
      return null;
    } catch (e) {
      // Swallowing a 5xx here would let the pipeline issue a DUPLICATE invoice
      // (the dedup check failed open). Re-throw transient; null only on a real
      // "no match" response from Moloni.
      if (isMoloniTransient(e)) throw e;
      return null;
    }
  }

  async createDraft(normalized: Normalized, ctx: AdapterCtx): Promise<DestinationInvoiceCreateResult> {
    const cfg = await getMoloniCfg(ctx);
    const token = await getAccessToken(cfg);

    // Resolve rate→tax_id only for UNMAPPED lines (they derive their rate from
    // the source, and ensureMoloniProduct needs the rule to create products).
    // Mapped lines carry the Moloni product's own taxes[] instead.
    await ensureTaxIdsByRate(
      cfg, token,
      normalized.order.items.filter((it) => !isReferenceMapped(ctx, it)).map((it) => taxRateForItem(it, ctx)),
    );

    const [customerId, resolved, exchange] = await Promise.all([
      resolveOrCreateCustomer(cfg, token, normalized),
      resolveProducts(cfg, token, normalized.order.items, (it) => taxRateForItem(it, ctx), ctx.productMappings),
      resolveMoloniExchange(cfg, token, normalized.order.currency),
    ]);
    const products = buildMoloniLineItems(normalized, ctx, resolved, cfg);
    if (products.length === 0) {
      throw new Error("Moloni create failed: no line items derived from normalized order");
    }

    // Source-of-truth invariant: invoice gross MUST equal source paid amount.
    // Abort before POST if line-item math drifts from normalized.order.total
    // (Shopify total_price / Stripe amount_received / EuPago valor) by > 1¢.
    reconcileTotalOrThrow(
      Number(normalized.order.total),
      products.map((p) => ({
        name: p.name,
        quantity: Number(p.qty),
        unit_price: Number(p.price),
        tax_rate: Number(p.taxes?.[0]?.value ?? 0),
        discount_percent: Number(p.discount ?? 0),
      })),
      { context: `→Moloni order#${normalized.order.order_number}` },
    );

    const exemptionReason = resolveExemptionReason(ctx);
    const needsExemption = products.some((p) => !p.taxes || p.taxes.length === 0);

    const payload: Record<string, unknown> = {
      document_set_id: cfg.documentSetId,
      customer_id: customerId,
      date: dateOnlyYmd(normalized.order.created_at),
      expiration_date: dateOnlyYmd(normalized.order.created_at),
      // Instalment invoices carry a distinct reference ("Order #N-1", "…-2") so
      // the dedup-by-reference doesn't block the second one; fall back to the
      // per-booking reference for normal single invoices.
      our_reference: normalized.order.invoice_reference ?? `Order #${normalized.order.order_number}`,
      your_reference: normalized.order.reference?.toString().slice(0, 100) ?? undefined,
      products,
      status: 0, // 0 = draft, 1 = closed/finalized
      notes: (normalized.order.note ?? "").toString().slice(0, 200),
      ...(needsExemption ? { exemption_reason: exemptionReason } : {}),
      // Non-EUR: issue in the paid currency; Moloni derives the EUR fiscal value.
      ...(exchange ? { exchange_currency_id: exchange.currencyId, exchange_rate: exchange.rate } : {}),
    };

    const insertPath = cfg.documentType === "invoice_receipt"
      ? "/invoiceReceipts/insert/"
      : "/invoices/insert/";
    const res = await moloniCall<{ document_id?: number }>(
      cfg, token, insertPath, payload, "create",
    );
    const id = res?.document_id;
    if (!id) {
      throw new Error(`Moloni create failed: insert returned no document_id — ${safeErrorJson(res)}`);
    }
    return { invoiceId: String(id) };
  }

  async finalize(invoiceId: string, ctx: AdapterCtx): Promise<void> {
    const cfg = await getMoloniCfg(ctx);
    const token = await getAccessToken(cfg);

    // Moloni's `invoices/update` flips status from 0 (draft) to 1 (closed).
    // Once status=1 the document is fiscally locked and gets an AT-validated
    // hash. Mirrors IX's `change_state -> finalized` flow.
    await moloniCall(
      cfg, token, "/invoices/update/",
      { document_id: Number(invoiceId), status: 1 },
      "finalize",
    );
  }

  async issueCredit(
    invoiceId: string,
    refund: NormalizedRefund,
    normalized: Normalized,
    ctx: AdapterCtx,
  ): Promise<DestinationCreditResult> {
    const cfg = await getMoloniCfg(ctx);
    const token = await getAccessToken(cfg);

    // Build refund lines from the items actually being refunded.
    const refundItems = normalized.order.items.filter((it) => refund.itemsIds.includes(it.id));
    const subset: Normalized = {
      ...normalized,
      order: { ...normalized.order, items: refundItems },
    };

    // Resolve rate→tax_id only for UNMAPPED refunded lines. Mapped lines carry
    // the Moloni product's own taxes[] (the cash-delta line reuses a line rate).
    await ensureTaxIdsByRate(
      cfg, token,
      refundItems.filter((it) => !isReferenceMapped(ctx, it)).map((it) => taxRateForItem(it, ctx)),
    );

    const [customerId, resolved, exchange] = await Promise.all([
      resolveOrCreateCustomer(cfg, token, normalized),
      resolveProducts(cfg, token, refundItems, (it) => taxRateForItem(it, ctx), ctx.productMappings),
      resolveMoloniExchange(cfg, token, normalized.order.currency),
    ]);

    const products = buildMoloniLineItems(subset, ctx, resolved, cfg);

    // Free-form refund delta when Shopify reports an amount beyond the line
    // items (e.g. partial cash refund). Mirrors IX adapter's behaviour.
    if (refund.amountToRefund > 0) {
      // Reuse the highest line rate for the cash delta. Track the line itself so
      // we can reuse its resolved tax_id — a mapped product's tax_id may not be
      // in the rate→id table.
      const maxTaxLine = products.reduce<MoloniProductLine | null>((acc, p) => {
        const t = p.taxes?.[0]?.value ?? 0;
        const accV = acc?.taxes?.[0]?.value ?? 0;
        return t > accV ? p : acc;
      }, null);
      const maxTax = maxTaxLine?.taxes?.[0]?.value ?? 0;
      const factor = maxTax > 0 ? 1 + maxTax / 100 : 1;
      const netUnit = Math.round((refund.amountToRefund / factor) * 10000) / 10000;
      const order = products.length + 1;
      // Cash-only refund delta has no source product. Ensure a synthetic
      // RIOKO-PLACEHOLDER product exists and reference it here. Resolve the rate
      // first so product creation doesn't throw when it came from a mapping.
      if (maxTax > 0) await ensureTaxIdsByRate(cfg, token, [maxTax]);
      const fallbackPid = await ensureMoloniProduct(
        cfg, token, FALLBACK_PLACEHOLDER_REFERENCE, "Rioko Refund Delta", maxTax,
      );
      const line: MoloniProductLine = {
        product_id: fallbackPid,
        name: `Refund amount (#${refund.refundId})`.slice(0, 200),
        summary: `Refund amount of ${refund.amountToRefund}`,
        qty: 1,
        price: netUnit,
        discount: 0,
        order,
      };
      if (maxTax > 0) {
        const tid = maxTaxLine?.taxes?.[0]?.tax_id ?? pickTaxId(cfg, maxTax);
        line.taxes = [{ tax_id: tid, value: maxTax, order: 1, cumulative: 0 }];
      } else {
        line.exemption_reason = resolveExemptionReason(ctx);
      }
      products.push(line);
    }

    if (products.length === 0) {
      throw new Error("Moloni credit create failed: no line items derived from refund");
    }

    const exemptionReason = resolveExemptionReason(ctx);
    const needsExemption = products.some((p) => !p.taxes || p.taxes.length === 0);

    const payload: Record<string, unknown> = {
      document_set_id: cfg.documentSetId,
      customer_id: customerId,
      date: todayYmd(),
      expiration_date: todayYmd(),
      our_reference: `OrderRefund #${refund.refundId}`,
      products,
      status: 0,
      // Moloni links credit notes back to the source document via
      // `associated_documents`. document_type_id is left untyped so Moloni
      // resolves from the parent's set.
      associated_documents: [{
        associated_id: Number(invoiceId),
        value: refund.amountToRefund > 0 ? refund.amountToRefund : products.reduce((acc, p) => acc + p.qty * p.price, 0),
      }],
      ...(needsExemption ? { exemption_reason: exemptionReason } : {}),
      // Mirror the source document's currency on the credit note.
      ...(exchange ? { exchange_currency_id: exchange.currencyId, exchange_rate: exchange.rate } : {}),
    };

    const inserted = await moloniCall<{ document_id?: number }>(
      cfg, token, "/creditNotes/insert/", payload, "credit create",
    );
    const creditId = inserted?.document_id;
    if (!creditId) {
      throw new Error(`Moloni credit create failed: insert returned no document_id — ${safeErrorJson(inserted)}`);
    }

    // Close the credit note immediately so it is fiscally valid, matching IX.
    await moloniCall(
      cfg, token, "/creditNotes/update/",
      { document_id: Number(creditId), status: 1 },
      "credit create",
    );

    return { creditId: String(creditId) };
  }

  async emailDocument(invoiceId: string, ctx: AdapterCtx): Promise<void> {
    const cfg = await getMoloniCfg(ctx);
    const token = await getAccessToken(cfg);

    // Fetch document to discover client email.
    const doc = await moloniCall<{ entity?: { email?: string }; email?: string }>(
      cfg, token, "/invoices/getOne/",
      { document_id: Number(invoiceId) },
      "email",
    );
    const email = (doc?.entity?.email ?? doc?.email ?? "").trim();
    if (!email) return;

    const subject = (ctx.config.ix_email_subject ?? "").trim() || "Documento emitido";
    const body = (ctx.config.ix_email_body ?? "").trim() || "Em anexo segue o documento emitido.";

    await moloniCall(
      cfg, token, "/documents/sendEmail/",
      {
        document_id: Number(invoiceId),
        email,
        subject,
        message: body,
      },
      "email",
    );
  }
}
