import type {
  DestinationAdapter,
  AdapterCtx,
  DestinationInvoiceCreateResult,
  DestinationCreditResult,
  DestinationDocument,
  CreditFullResult,
  FinalizeBatch,
  FinalizeDateStrategy,
  FinalizeOutcome,
  NormalizedRefund,
  SettleOutcome,
  SettleDocSnapshot,
} from "../types";
import type { Normalized } from "../../api/normalize-shopify";
import { validatePTNIF } from "../../ix/nif";
import { reconcileTotalOrThrow, receiptDelta } from "../reconcile";
import { redactSecrets } from "../../security";
import { refundReference, isRefundReference, documentReference } from "../../services/document-references";
import { platformError } from "../../services/platform-error";

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
  // Credit-note lines only: the document_product_id of the ORIGINAL invoice line
  // this line credits. Moloni's creditNotes/insert REQUIRES it (fails with
  // ["5 related_id"] otherwise). Absent on invoice/receipt lines.
  related_id?: number;
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
  // Where generated products are filed. Unset = the account's FIRST category,
  // which on a fresh Moloni account is the demo one ("Categoria exemplo"), so a
  // merchant who cares should pin `moloni_category_id`.
  categoryId: number;
  // Payment terms stamped on the document ("Pronto Pagamento", "30 Dias", …).
  // Unset = none sent, which Moloni renders as due on the issue date.
  maturityDateId: number;
  // Where a RECIBO is filed, for an account that keeps receipts apart from
  // invoices. Unset = the invoice série, right for an account whose série covers
  // every document type (Origos: "2026", 17 AT codes) and wrong for one that
  // pairs each invoice série with its own (Overbuilding: AVENCARB invoices,
  // RAVENCARB receipts).
  //
  // A MAP, not one name, because tag routing sends each sale to a série of its
  // own: Overbuilding routes five properties to VLFR and three to RVFR from a
  // single connection, so the receipt série has to follow the série the document
  // was actually issued in. Keyed by invoice série name, lowercased.
  receiptSeriesMap?: Record<string, string>;
  // The one-pairing shorthand, for an account with a single invoice série.
  receiptDocumentSetName?: string;
  receiptDocumentSetId?: number;
};

// Endpoint family per document type. Every operation on a document MUST use the
// family it was inserted into — Moloni scopes document_id per collection, so
// /invoices/update/ on an id that lives in /invoiceReceipts/ silently 404s and
// auto-finalize fails without an error the merchant would ever see.
const MOLONI_PATHS = {
  invoice: {
    insert: "/invoices/insert/", update: "/invoices/update/",
    getOne: "/invoices/getOne/", getAll: "/invoices/getAll/",
    delete: "/invoices/delete/",
  },
  invoice_receipt: {
    insert: "/invoiceReceipts/insert/", update: "/invoiceReceipts/update/",
    getOne: "/invoiceReceipts/getOne/", getAll: "/invoiceReceipts/getAll/",
    delete: "/invoiceReceipts/delete/",
  },
  simplified_invoice: {
    insert: "/simplifiedInvoices/insert/", update: "/simplifiedInvoices/update/",
    getOne: "/simplifiedInvoices/getOne/", getAll: "/simplifiedInvoices/getAll/",
    delete: "/simplifiedInvoices/delete/",
  },
} as const;

type MoloniDocKind = keyof typeof MOLONI_PATHS;

// A Recibo is not a sale document and deliberately does NOT live in
// MOLONI_PATHS: that table is what tag routing may choose a `document_type`
// from, and a routing rule that pointed a sale at /receipts/ would issue a
// settlement for a stay nobody had invoiced.
const MOLONI_RECEIPT_PATHS = {
  insert: "/receipts/insert/",
  getOne: "/receipts/getOne/",
  getAll: "/receipts/getAll/",
} as const;

/** Unknown/absent type falls back to plain invoice, as it always has. */
function docKind(cfg: Pick<MoloniCfg, "documentType">): MoloniDocKind {
  const t = String(cfg.documentType ?? "").toLowerCase();
  return (t in MOLONI_PATHS ? t : "invoice") as MoloniDocKind;
}

export function moloniPath(cfg: Pick<MoloniCfg, "documentType">, op: keyof typeof MOLONI_PATHS["invoice"]): string {
  return MOLONI_PATHS[docKind(cfg)][op];
}

/**
 * The configured collection first, then the others — a document created before
 * the merchant changed the type (or routed by a tag rule to a different one)
 * still has to be findable.
 */
export function moloniPathsWithFallback(cfg: Pick<MoloniCfg, "documentType">, op: keyof typeof MOLONI_PATHS["invoice"]): string[] {
  const primary = docKind(cfg);
  const rest = (Object.keys(MOLONI_PATHS) as MoloniDocKind[]).filter((k) => k !== primary);
  return [primary, ...rest].map((k) => MOLONI_PATHS[k][op]);
}

// A simplified invoice is capped at 1.000 € (art. 40.º CIVA) and identifies the
// buyer by NIF only — it cannot carry a full client record. Above the cap, or
// when the buyer gave a NIF they will want on a proper invoice, we downgrade to
// a full invoice instead of letting Moloni reject the insert.
export const SIMPLIFIED_INVOICE_MAX_TOTAL = 1000;

/**
 * Why this sale cannot be a simplified invoice, or null if it can.
 *
 * A non-finite total is treated as unknown rather than "under the cap": we
 * would rather issue a full invoice than gamble a fiscal document on a number
 * we could not read.
 */
export function simplifiedInvoiceBlocker(
  total: number,
  buyerNif: string | null,
): "over_cap" | "unknown_total" | "has_nif" | null {
  if (!Number.isFinite(total)) return "unknown_total";
  if (total > SIMPLIFIED_INVOICE_MAX_TOTAL) return "over_cap";
  if (buyerNif) return "has_nif";
  return null;
}

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
  const receiptDocumentSetName = String(c.moloni_receipt_document_set_name ?? "").trim() || undefined;
  const receiptDocumentSetId = Number(c.moloni_receipt_document_set_id ?? 0) || undefined;
  // Accepts the map as an object or as the JSON string the console stores.
  let receiptSeriesMap: Record<string, string> | undefined;
  try {
    const rawMap = c.moloni_receipt_series_map;
    const parsed = typeof rawMap === "string" ? JSON.parse(rawMap) : rawMap;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed as Record<string, unknown>)
        .filter(([k, v]) => String(k).trim() && String(v ?? "").trim())
        .map(([k, v]) => [String(k).trim().toLowerCase(), String(v).trim()] as [string, string]);
      if (entries.length > 0) receiptSeriesMap = Object.fromEntries(entries);
    }
  } catch {
    // A malformed map reads as absent here and is named at settle time, where
    // there is a document to name it against.
  }
  const categoryId = Number(c.moloni_category_id ?? 0);
  const maturityDateId = Number(c.moloni_maturity_date_id ?? 0);
  return {
    baseUrl: env, clientId, clientSecret, username, password, companyId, documentSetId,
    companyName, documentSetName, defaultTaxId, documentType, categoryId, maturityDateId,
    receiptSeriesMap, receiptDocumentSetName, receiptDocumentSetId,
  };
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
  opName: "create" | "finalize" | "credit create" | "email" | "lookup" | "delete",
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
    throw platformError(`Moloni ${opName} failed: ${res.status} — ${safeErrorJson(json)}`, res.status);
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

// Extracts a 9-digit PT NIF candidate from the same fields IX's builder reads.
// Pared down from IxBuilder.extractAndValidateNIF — we only need a yes/no PT
// fiscal id here, the heavy EU-VAT shape work is owned by IX.
export function extractPtNif(normalized: Normalized): string | null {
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

/**
 * True when the sale carries a fiscal id that names Portugal in the id ITSELF —
 * a `pt_nif` tax id, or an EU-VAT value spelled "PT196940737".
 *
 * Used to settle the one genuine conflict: a billing address that names another
 * country while the fiscal id says Portugal. The id wins, because it is the
 * fiscal statement and the address is often just where a card is registered.
 * (An ABSENT address is no conflict at all — see resolveOrCreateCustomer.)
 */
export function hasPtFiscalMarker(order: Normalized["order"]): boolean {
  const attrs = Array.isArray(order.note_attributes)
    ? (order.note_attributes as Array<{ name?: string; value?: unknown }>)
    : [];
  for (const attr of attrs) {
    if (!attr) continue;
    const name = String(attr.name ?? "").toLowerCase();
    // Stripe stamps the tax-id TYPE into the attribute name — "vat (pt_nif)".
    if (name.includes("pt_nif")) return true;
    const value = String(attr.value ?? "").toUpperCase().replace(/[\s.-]/g, "");
    if (/^PT\d{9}$/.test(value)) return true;
  }
  return false;
}

export interface MoloniUnit { unit_id?: number; name?: string; short_name?: string }

/**
 * The measurement unit a generated product is created with.
 *
 * This used to take `units[0]` — whatever Moloni happened to list first for that
 * company. On MJ | SENTE that is "Hrs", so every Stripe payment was invoiced as
 * hours of something. A sale of one thing is one UNIT unless the merchant says
 * otherwise, so look for the account's own "unidade" and only fall back to the
 * first entry when the account genuinely has no such unit.
 *
 * This only governs products Rioko generates. A merchant who genuinely bills in
 * hours (or kg, or nights) maps their own Moloni product, and that product's
 * unit is used — same escape hatch that already carries its VAT rate.
 */
export function pickUnitId(units: MoloniUnit[] | unknown): number | undefined {
  const list = (Array.isArray(units) ? units : []).filter((u): u is MoloniUnit => !!u?.unit_id);
  const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();
  const isUnitOfCount = (u: MoloniUnit) => {
    const short = norm(u.short_name);
    const name = norm(u.name);
    return /^(un|uni|unid|und|unidade|unidades|unit|units)\.?$/.test(short)
      || /^(unidade|unidades|unit|units)$/.test(name);
  };
  return Number(list.find(isUnitOfCount)?.unit_id ?? list[0]?.unit_id) || undefined;
}

/**
 * Whether the NIF we extracted may be stamped on the document.
 *
 * A missing address is NOT a reason to drop a NIF: an invoice may perfectly well
 * carry a fiscal id and no billing address at all (Multibanco, Link and
 * off-session subscription charges collect none). Only an address that names a
 * DIFFERENT country contradicts the NIF — and even that loses to a fiscal id
 * that spells Portugal out itself.
 *
 * This used to demand `country_code === "PT"`, so every address-less sale was
 * read as foreign and billed to the shared "Consumidor Final" record with the
 * buyer's valid NIF sitting right there in the payload.
 *
 * `extractPtNif` already normalizes "PT196940737" → "196940737" and verifies the
 * check digit, so nothing structurally invalid reaches this decision.
 */
export function ptNifApplies(order: Normalized["order"], ptNif: string | null): boolean {
  if (!ptNif) return false;
  const billingCountry = String(order.billing_address?.country_code ?? "").trim().toUpperCase();
  const addressNamesAnotherCountry = billingCountry !== "" && billingCountry !== "PT";
  return hasPtFiscalMarker(order) || !addressNamesAnotherCountry;
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
  if (item.tax.unit_amount !== 0) return Number(item.tax.value);
  // Fallback: the connection's default VAT rate, applied when the payment carries
  // no tax breakdown (e.g. Stripe PaymentIntents). Stripe's real tax above always
  // wins; this is the last resort before treating the line as exempt.
  const def = Number((ctx.destinationConfig as any)?.default_vat_rate);
  return Number.isFinite(def) && def > 0 ? def : 0;
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

const paymentMethodCache = new Map<number, Map<string, number>>();

/**
 * Resolve the Moloni payment method to stamp on a fatura-recibo.
 *
 * A fatura-recibo asserts the money was received, so it should say how. For an
 * OTA stay that is the channel — the host never touches the guest's card, and
 * "Airbnb" on the document is what ties it to the payout line in the bank.
 *
 * Matched by NAME against the company's own methods, because ids differ per
 * account. Missing method = an actionable error rather than a silent fallback:
 * stamping "Numerário" on an Airbnb payout would be a quiet lie in a fiscal
 * document, and the fix (create the method in Moloni, or name an existing one
 * in the connection) takes a minute.
 */
async function resolvePaymentMethodId(cfg: MoloniCfg, token: string, wanted: string): Promise<number> {
  let map = paymentMethodCache.get(cfg.companyId);
  if (!map) {
    const methods = await moloniCall<Array<{ payment_method_id?: number; name?: string }>>(
      cfg, token, "/paymentMethods/getAll/", {}, "lookup",
    );
    map = new Map<string, number>();
    if (Array.isArray(methods)) {
      for (const m of methods) {
        const id = Number(m.payment_method_id);
        const name = String(m.name ?? "").trim().toLowerCase();
        if (id > 0 && name && !map.has(name)) map.set(name, id);
      }
    }
    paymentMethodCache.set(cfg.companyId, map);
  }

  const needle = wanted.trim().toLowerCase();
  const exact = map.get(needle);
  if (exact) return exact;
  // "Booking.com" vs "Booking", "Airbnb" vs "AirBnB Portugal" — accept either
  // side containing the other, longest match first so "Booking.com" beats
  // "Booking" when both exist.
  const fuzzy = [...map.entries()]
    .filter(([name]) => name.includes(needle) || needle.includes(name))
    .sort((a, b) => b[0].length - a[0].length)[0];
  if (fuzzy) return fuzzy[1];

  throw new Error(
    `Moloni: company ${cfg.companyId} has no payment method named "${wanted}" ` +
    `(available: ${[...map.keys()].join(", ") || "none"}). Create it in Moloni, ` +
    `or set moloni_payment_method on the connection to one of those names.`,
  );
}

/**
 * Which payment method name this document should carry, or null to stamp none.
 *
 * `moloni_payment_method` on the connection wins: it is a merchant naming a
 * method that exists in their own account, and most accounts have no "Airbnb"
 * method — the platform pays out by bank transfer, so "Transferência Bancária"
 * is both true and already there. Only when nothing is configured do we derive
 * the channel from the reference ("Airbnb: HM…" → "Airbnb").
 *
 * Either way the channel stays identifiable: it is stamped in the document's
 * notes. Only ever applied to a fatura-recibo — a plain fatura records no
 * payment by definition.
 */
export function paymentMethodNameFor(
  order: { channel_reference?: string | null },
  destinationConfig: Record<string, any> | undefined,
): string | null {
  const configured = destinationConfig?.moloni_payment_method;
  if (typeof configured === "string" && configured.trim()) return configured.trim();

  const ref = order.channel_reference;
  if (typeof ref === "string" && ref.includes(":")) {
    const channel = ref.slice(0, ref.indexOf(":")).trim();
    if (channel) return channel;
  }
  return null;
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

    // Unmapped reference: derive the rate from the source (or force_tax_rate/default).
    const taxRate = taxRateForItem(item, ctx);
    if (taxRate > 0) {
      // Moloni `price` is NET. When the rate did NOT come from the source (the
      // payment carried no tax — e.g. a Stripe PaymentIntent, so item.unit_price
      // is the GROSS amount paid) and prices are VAT-inclusive, back out the net
      // so net + VAT reproduces exactly what the buyer paid (reconcile enforces it).
      const sourceProvidedTax = item.tax.unit_amount !== 0;
      const vatIncluded = (ctx.destinationConfig as any)?.vat_included !== false;
      if (!sourceProvidedTax && vatIncluded) {
        line.price = Math.round((item.unit_price / (1 + taxRate / 100)) * 10000) / 10000;
      }
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
  const vat = ptNifApplies(order, ptNif) ? ptNif! : NON_PT_GENERIC_VAT;

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
  //
  // A pinned `moloni_category_id` wins. Without one we take the account's first
  // category, which on a fresh Moloni account is the demo entry ("Categoria
  // exemplo — Produtos/Serviços") — harmless but wrong, and it files a real
  // business's whole catalogue under a sample.
  let categoryId: number | undefined = cfg.categoryId > 0 ? cfg.categoryId : undefined;
  if (!categoryId) {
    const categories = await moloniCall<Array<{ category_id?: number }>>(
      cfg, token, "/productCategories/getAll/",
      { parent_id: 0 },
      "lookup",
    );
    categoryId = Array.isArray(categories) ? categories[0]?.category_id : undefined;
  }
  if (!categoryId) {
    throw new Error(`Moloni create failed: no product category available to host product '${reference}'`);
  }
  const units = await moloniCall<MoloniUnit[]>(
    cfg, token, "/measurementUnits/getAll/", {}, "lookup",
  );
  const unitId = pickUnitId(units);
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

function formatPtYmd(ymd: string): string {
  const [y, m, d] = ymd.split("-");
  return d && m && y ? `${d}/${m}/${y}` : ymd;
}

// Moloni forbids a new document dated BEFORE the last one already issued in its
// series/type — even a draft — returning a validation error like
// "12 date >= 2026-07-05". This bites any late issuance: a re-emit of an old
// payment, a long-delayed webhook, a backfill. When it happens, re-date to the
// series minimum Moloni reports (the closest allowed date) and stamp the real
// transaction date in the notes — the correct fiscal practice for issuing today
// a document for a past payment. Returns the (possibly re-dated) insert result.
// Fetch the source document's line items so a credit note can carry the
// required per-line `related_id` (= each original line's document_product_id).
// The id may be an invoice OR an invoice_receipt (tag-routing / the client's
// document_type), so try the configured type first, then the other. Returns []
// when neither endpoint has it (deleted / wrong id).
interface MoloniBaseLine {
  product_id?: number;
  document_product_id?: number;
  /** First tax rule on the original line — reused so a cash-only credit note
   * (Stripe refund) mirrors the source document's VAT instead of going exempt. */
  tax_id?: number;
  tax_value?: number;
}

/**
 * Read a document back, whichever endpoint family it happens to live under.
 *
 * A stored id may be an invoice OR an invoiceReceipt (tag routing and the
 * client's document_type both decide per order), so the configured type is tried
 * first and the others after. Returns the path that resolved it, because delete
 * and update have to be addressed to the SAME family.
 */
async function fetchMoloniDocument(
  cfg: MoloniCfg,
  token: string,
  documentId: string | number,
): Promise<{ doc: any; path: string } | null> {
  for (const path of moloniPathsWithFallback(cfg, "getOne")) {
    const d = await moloniCall<any>(cfg, token, path, { document_id: Number(documentId) }, "lookup").catch(() => null);
    if (d && typeof d === "object" && !Array.isArray(d) && d.document_id != null) {
      return { doc: d, path };
    }
  }
  return null;
}

/**
 * Moloni labels the two totals inconsistently (see the moloni-api-quirks note),
 * so the gross is whichever is larger rather than whichever is named `gross`.
 */
/**
 * The exemption code Moloni is holding for a document.
 *
 * Unlike InvoiceXpress, which stamps one `tax_exemption` on the header, Moloni
 * attaches `exemption_reason` to each product line. So the document's code is
 * the code its lines agree on. When they disagree — which is itself worth
 * seeing, since a single mismatched line changes what the document declares —
 * the codes are returned joined rather than resolved to the first one.
 */
function moloniExemptionCode(doc: any): string | null {
  const codes = new Set<string>();
  for (const p of (doc?.products ?? doc?.items ?? []) as any[]) {
    const c = p?.exemption_reason ?? p?.exemption ?? null;
    if (c != null && String(c).trim()) codes.add(String(c).trim());
  }
  if (codes.size === 0) return null;
  return [...codes].sort().join("+");
}

function moloniDocTotal(doc: any): number | null {
  const total = Math.max(Number(doc?.net_value ?? 0), Number(doc?.gross_value ?? 0)) || Number(doc?.total ?? 0);
  return Number.isFinite(total) && total !== 0 ? total : null;
}

// The source document's line items, for the per-line `related_id` a credit note
// requires and for the cash-delta VAT rate.
async function fetchMoloniDocLines(
  cfg: MoloniCfg,
  token: string,
  documentId: string | number,
): Promise<MoloniBaseLine[]> {
  const found = await fetchMoloniDocument(cfg, token, documentId);
  if (!found || !Array.isArray(found.doc.products)) return [];
  return (found.doc.products as any[]).map((p) => ({
    product_id: p?.product_id,
    document_product_id: p?.document_product_id,
    tax_id: p?.taxes?.[0]?.tax_id,
    tax_value: p?.taxes?.[0]?.value != null ? Number(p.taxes[0].value) : undefined,
  }));
}

/**
 * The date Moloni's series-chronology rule is demanding, or null if the failure
 * was about something else.
 *
 * Moloni words it as a validation entry — `["12 date >= 2026-08-12"]` — and
 * raises it on BOTH ends of a document's life: at insert, and again at close
 * (status 0 → 1), because closing is when the document takes its number in the
 * series. The second half cost a bulk run: 21 of 22 drafts were rejected after
 * the first one closed at a later date and lifted the floor over all of them.
 */
export function moloniSeriesMinDate(error: unknown): string | null {
  const msg = String((error as { message?: string })?.message ?? error ?? "");
  const m = msg.match(/date\s*>=\s*(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

async function insertMoloniDoc(
  cfg: MoloniCfg,
  token: string,
  insertPath: string,
  payload: Record<string, unknown>,
): Promise<{ document_id?: number }> {
  try {
    return await moloniCall<{ document_id?: number }>(cfg, token, insertPath, payload, "create");
  } catch (e) {
    const minYmd = moloniSeriesMinDate(e);
    if (!minYmd) throw e;
    const originalYmd = typeof payload.date === "string" ? payload.date : todayYmd();
    const paymentNote = `Data do pagamento: ${formatPtYmd(originalYmd)}`;
    const existingNotes = typeof payload.notes === "string" ? payload.notes.trim() : "";
    const retry: Record<string, unknown> = {
      ...payload,
      date: minYmd,
      expiration_date: minYmd,
      notes: (existingNotes ? `${existingNotes} | ${paymentNote}` : paymentNote).slice(0, 200),
    };
    return await moloniCall<{ document_id?: number }>(cfg, token, insertPath, retry, "create");
  }
}

/**
 * Move a draft's date forward, stamping the real transaction date in its notes.
 *
 * Moloni's update is a partial one — the same endpoint closes a document with
 * nothing but `{document_id, status}` — so only the header fields travel here.
 * `expiration_date` moves WITH `date`: a due date behind the issue date is the
 * other half of every rejected re-date we have seen, on Moloni and IX alike.
 *
 * The document is read back before it is closed. A date change must never move
 * money, and closing is irreversible, so a read-back whose total no longer
 * matches the draft we measured stops the run for that row instead of certifying
 * a document we have stopped recognising.
 */
/**
 * Which série a Recibo is filed under, for the invoice it settles.
 *
 * An account whose série covers every document type (Origos: "2026") settles
 * inside the invoice série. An account that pairs each invoice série with a
 * receipt série does not: Overbuilding's receipts sit in RAVENCARB and
 * RAVENCAABLIS while its invoices sit in AVENCARB and AVENCAABLIS.
 *
 * `invoiceSeriesName` is the série the DOCUMENT was issued in, read off the
 * document itself and not off the connection. Tag routing makes them differ:
 * Overbuilding routes five properties to VLFR and three to RVFR from one
 * connection, so a receipt série chosen from the connection would be wrong for
 * whichever half did not match.
 *
 * Never guesses a pairing. Only a human knows that VLFR's receipts belong in
 * VLR, and a fiscal document filed in the wrong book is not a mistake worth
 * automating — a configured map with no entry for this série is an error, said
 * out loud, rather than a Recibo somewhere plausible.
 */
async function resolveReceiptDocumentSetId(
  cfg: MoloniCfg,
  token: string,
  invoiceSeriesName?: string | null,
): Promise<number> {
  if (cfg.receiptSeriesMap) {
    const mapped = cfg.receiptSeriesMap[String(invoiceSeriesName ?? "").trim().toLowerCase()];
    if (!mapped) {
      throw new Error(
        `Moloni: não há série de recibos configurada para a série "${invoiceSeriesName ?? "?"}" `
        + `(moloni_receipt_series_map cobre: ${Object.keys(cfg.receiptSeriesMap).join(", ")})`,
      );
    }
    return await documentSetIdByName(cfg, token, mapped);
  }
  if (cfg.receiptDocumentSetId) return cfg.receiptDocumentSetId;
  if (!cfg.receiptDocumentSetName) return cfg.documentSetId;
  return await documentSetIdByName(cfg, token, cfg.receiptDocumentSetName);
}

/** Série name to id, for the receipt path. Throws with the account's own list. */
async function documentSetIdByName(cfg: MoloniCfg, token: string, name: string): Promise<number> {

  const res = await fetch(
    `${cfg.baseUrl}/documentSets/getAll/?access_token=${encodeURIComponent(token)}&json=true`,
    { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" }, body: JSON.stringify({ company_id: cfg.companyId }) },
  );
  const data = await safeJson(res);
  const list = Array.isArray(data) ? data : [];
  const wanted = name.trim().toLowerCase();
  const match = list.find((d: any) => String(d.name ?? d.document_set_name ?? "").toLowerCase() === wanted);
  if (!match) {
    const names = list.map((d: any) => `"${d.name ?? d.document_set_name}"`).join(", ");
    throw new Error(`Moloni: receipt série "${name}" not found. Available: ${names || "(none)"}`);
  }
  return Number((match as any).document_set_id ?? (match as any).id);
}

async function redateMoloniDraft(
  cfg: MoloniCfg,
  token: string,
  updatePath: string,
  o: {
    documentId: string;
    targetDate: string;
    originalDate: string;
    existingNotes: string;
    note: string | null;
    expectedTotal: number | null;
  },
): Promise<void> {
  // The caller's note names the transaction ("o pagamento Stripe pi_… de
  // 30/07/2026"); with none, say at least when the money actually moved — a
  // document dated later than its payment must carry the real date somewhere.
  const note = o.note ?? `Data do pagamento: ${formatPtYmd(o.originalDate)}`;
  const existing = o.existingNotes.trim();
  const notes = (existing ? `${existing} | ${note}` : note).slice(0, 200);

  await moloniCall(cfg, token, updatePath, {
    document_id: Number(o.documentId),
    date: o.targetDate,
    expiration_date: o.targetDate,
    notes,
  }, "finalize");

  const after = await fetchMoloniDocument(cfg, token, o.documentId);
  if (!after) throw new Error(`documento ${o.documentId} desapareceu depois da mudança de data`);
  if (Number(after.doc.status ?? 0) !== 0) {
    throw new Error(`documento ${o.documentId} já não é rascunho depois da mudança de data`);
  }
  const storedDate = typeof after.doc.date === "string" ? after.doc.date.slice(0, 10) : null;
  if (storedDate !== o.targetDate) {
    throw new Error(`o Moloni ficou com a data ${storedDate ?? "?"} e não ${o.targetDate}`);
  }
  const afterTotal = moloniDocTotal(after.doc);
  if (o.expectedTotal != null && (afterTotal == null || Math.abs(afterTotal - o.expectedTotal) > 0.011)) {
    throw new Error(
      `o total mudou de ${o.expectedTotal.toFixed(2)}€ para ${afterTotal?.toFixed(2) ?? "?"}€ — não fecho o documento`,
    );
  }
}

/**
 * Per-run state for one bulk finalize.
 *
 * `seriesMinDate` is the floor Moloni is currently enforcing on the series, and
 * it is deliberately mutable: it advances as this run closes documents, so the
 * second row already knows the date the first one just imposed instead of
 * learning it from a rejection. It starts null and is learned from Moloni's own
 * error rather than read up-front — Moloni reports the exact minimum it wants,
 * which is more reliable than reconstructing it from a document listing.
 */
export interface MoloniFinalizeBatch extends FinalizeBatch {
  readonly kind: "moloni";
  seriesMinDate: string | null;
}

function isMoloniBatch(b: FinalizeBatch | undefined): b is MoloniFinalizeBatch {
  return !!b && b.kind === "moloni";
}

/** The later of two YYYY-MM-DD dates; string order is date order for ISO days. */
function laterYmd(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

export class MoloniDestination implements DestinationAdapter {
  readonly kind = "moloni" as const;

  // Moloni DOES reject a close whose date falls behind the last document already
  // closed in the series ("12 date >= 2026-08-12"), exactly like InvoiceXpress —
  // so `finalizeWithDate` negotiates the date here too, and the flag says so.
  readonly capabilities = {
    drafts: true,
    deleteDraft: true,
    creditFullDocument: true,
    finalizeWithDate: true,
    emailDocument: true,
    readDocument: true,
    settleDocument: true,
  } as const;

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
      const isCreditRef = isRefundReference(reference);
      // Search EVERY sale-document family, not just the connection's configured
      // one. The document may have been written elsewhere: a tag routing rule
      // can send a sale to another type, and the settlement override sends a
      // part-paid stay to /invoices/ on a connection whose default is
      // invoice_receipt. Moloni scopes ids and reference lookups per collection,
      // so a lookup in the wrong family answers "no such document" and the
      // caller cheerfully issues a second one. Costs one extra call only when
      // the first family misses.
      const getAllPaths = isCreditRef
        ? ["/creditNotes/getAll/"]
        : moloniPathsWithFallback(cfg, "getAll");
      for (const getAllPath of getAllPaths) {
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
      }
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

    let payments: Array<Record<string, unknown>> | undefined;
    if (cfg.documentType === "invoice_receipt") {
      const methodName = paymentMethodNameFor(normalized.order, ctx.destinationConfig);
      if (methodName) {
        payments = [{
          payment_method_id: await resolvePaymentMethodId(cfg, token, methodName),
          date: dateOnlyYmd(normalized.order.created_at),
          value: Number(normalized.order.total ?? 0),
        }];
      }
    }

    const payload: Record<string, unknown> = {
      document_set_id: cfg.documentSetId,
      customer_id: customerId,
      date: dateOnlyYmd(normalized.order.created_at),
      expiration_date: dateOnlyYmd(normalized.order.created_at),
      // Instalment invoices carry a distinct reference ("Order #N-1", "…-2") so
      // the dedup-by-reference doesn't block the second one; fall back to the
      // per-booking reference for normal single invoices.
      our_reference: documentReference(normalized.order),
      your_reference: normalized.order.reference?.toString().slice(0, 100) ?? undefined,
      products,
      status: 0, // 0 = draft, 1 = closed/finalized
      // Payment terms ("Pronto Pagamento", "30 Dias"). Omitted unless pinned,
      // in which case Moloni renders the document as due on its issue date.
      ...(cfg.maturityDateId > 0 ? { maturity_date_id: cfg.maturityDateId } : {}),
      // A fatura-recibo says the money was received; without a payment line it
      // says so without saying how. Stamp the channel that took it ("Airbnb"),
      // or the connection's configured method. A plain fatura records no
      // payment by definition and never gets one.
      ...(payments ? { payments } : {}),
      // Channel reference first: on an OTA stay it is the only thread back to
      // the payout that covers this document, and the guest note (when there is
      // one) is a NIF the customer record already carries.
      notes: [normalized.order.channel_reference, normalized.order.note]
        .filter((v) => v != null && String(v).trim() !== "")
        .join(" | ")
        .slice(0, 200),
      ...(needsExemption ? { exemption_reason: exemptionReason } : {}),
      // Non-EUR: issue in the paid currency; Moloni derives the EUR fiscal value.
      ...(exchange ? { exchange_currency_id: exchange.currencyId, exchange_rate: exchange.rate } : {}),
    };

    const res = await insertMoloniDoc(cfg, token, moloniPath(cfg, "insert"), payload);
    const id = res?.document_id;
    if (!id) {
      throw new Error(`Moloni create failed: insert returned no document_id — ${safeErrorJson(res)}`);
    }
    return { invoiceId: String(id) };
  }

  /**
   * Delete a document that is still a draft. Used to take back a document whose
   * underlying sale evaporated (a cancelled booking) before it was ever closed.
   *
   * Refuses anything already finalized: a closed document is fiscally locked and
   * AT-hashed, and the only lawful way to undo it is a credit note. Returns
   * "already_gone" when the id resolves nowhere, so a retry after a partial
   * failure is a no-op rather than an error.
   */
  /**
   * Read a document back. Moloni's `status` is numeric: 0 = rascunho, 1 = fechado
   * (per its API docs), and a closed document can be neither updated nor deleted.
   *
   * Moloni has no "canceled" state of its own — a closed document is undone with
   * a credit note, so `finalized` and `canceled` do not need telling apart here
   * the way they do on InvoiceXpress.
   */
  async getDocument(invoiceId: string, ctx: AdapterCtx): Promise<DestinationDocument | null> {
    const cfg = await getMoloniCfg(ctx);
    const token = await getAccessToken(cfg);
    const found = await fetchMoloniDocument(cfg, token, invoiceId);
    if (!found) return null;

    const d = found.doc;
    return {
      id: String(d.document_id),
      state: Number(d.status ?? 0) === 0 ? "draft" : "finalized",
      date: typeof d.date === "string" ? d.date.slice(0, 10) : null,
      total: moloniDocTotal(d),
      reference: d.our_reference != null ? String(d.our_reference) : null,
      // Moloni numbers a document only once it closes.
      number: d.document_set_name && d.number ? `${d.document_set_name} ${d.number}` : (d.number ?? null),
      permalink: null,
      // Moloni carries the exemption on the LINES, not the header, so the
      // document's code is the one its products agree on; a mix is reported as
      // such rather than silently picking the first.
      exemption_code: moloniExemptionCode(d),
      raw: d,
    };
  }

  async deleteDraft(invoiceId: string, ctx: AdapterCtx): Promise<"deleted" | "already_gone" | "finalized"> {
    const cfg = await getMoloniCfg(ctx);
    const token = await getAccessToken(cfg);

    const resolved = await fetchMoloniDocument(cfg, token, invoiceId);
    if (!resolved) return "already_gone";
    const found = { path: resolved.path, status: Number(resolved.doc.status ?? 0) };
    if (found.status !== 0) return "finalized";

    // getOne and delete share a family, so derive the delete path from the
    // endpoint that actually resolved the id rather than from the config.
    const deletePath = found.path.replace(/getOne\/$/, "delete/");
    await moloniCall(cfg, token, deletePath, { document_id: Number(invoiceId) }, "delete");
    return "deleted";
  }

  async finalize(invoiceId: string, ctx: AdapterCtx): Promise<void> {
    const cfg = await getMoloniCfg(ctx);
    const token = await getAccessToken(cfg);

    // Flip status 0 (draft) → 1 (closed); the document is then fiscally locked
    // with an AT-validated hash. MUST target the SAME document type the draft was
    // created as — an invoice_receipt connection issues /invoiceReceipts/, so
    // /invoices/update/ would 404 the id and auto-finalize would silently fail.
    // Mirrors the insert path pick — tag routing makes this three-way now, and
    // the route is replayed from processed_orders.routed_json before we get here.
    await moloniCall(
      cfg, token, moloniPath(cfg, "update"),
      { document_id: Number(invoiceId), status: 1 },
      "finalize",
    );
  }

  /**
   * Credit a closed document in full, mirroring its OWN lines.
   *
   * Distinct from `issueCredit`, which needs a live refund at the source. This is
   * the operator cancelling a sale after the fact: there is no refund payload to
   * derive lines from, so they come from the document itself. Rebuilding them
   * from a refetched order would credit what the order says today rather than
   * what the document says, and the two drift.
   */
  async creditFullDocument(
    invoiceId: string,
    ctx: AdapterCtx,
    opts: { reference: string; matchReferences?: string[]; reason?: string | null; dryRun?: boolean },
  ): Promise<CreditFullResult> {
    const cfg = await getMoloniCfg(ctx);
    const token = await getAccessToken(cfg);

    // Idempotency by reference, checked against every historical spelling.
    // Moloni ignores filters it does not recognise and returns everything, so the
    // match is re-checked client-side — a loose filter accepted as a hit here
    // would silently refuse to credit a document that was never credited.
    const matchRefs = opts.matchReferences ?? [opts.reference];
    for (const ref of matchRefs) {
      const found = await moloniCall<any[]>(
        cfg, token, "/creditNotes/getAll/", { our_reference: ref }, "lookup",
      ).catch(() => []);
      const hit = (Array.isArray(found) ? found : []).find((d) => String(d?.our_reference ?? "") === ref);
      if (hit?.document_id != null) {
        return { creditId: String(hit.document_id), number: hit.number ?? null, alreadyExisted: true };
      }
    }

    const source = await fetchMoloniDocument(cfg, token, invoiceId);
    if (!source) throw new Error(`Moloni document ${invoiceId} not found — nothing to credit`);
    if (Number(source.doc.status ?? 0) === 0) {
      throw new Error(`Document ${invoiceId} is still a draft. Delete it instead of crediting it.`);
    }

    const baseLines: any[] = Array.isArray(source.doc.products) ? source.doc.products : [];
    if (baseLines.length === 0) {
      throw new Error(`Moloni document ${invoiceId} has no lines to credit`);
    }

    // Mirror each line back, carrying the per-line `related_id` Moloni requires
    // (the source line's document_product_id) and its own tax rule.
    const products: MoloniProductLine[] = baseLines.map((p, i) => {
      const taxes = Array.isArray(p?.taxes) && p.taxes.length > 0
        ? p.taxes.map((t: any, ti: number) => ({
            tax_id: Number(t.tax_id),
            value: Number(t.value ?? 0),
            order: ti + 1,
            cumulative: Number(t.cumulative ?? 0),
          }))
        : undefined;
      const line: MoloniProductLine = {
        product_id: Number(p.product_id),
        name: String(p.name ?? "Artigo").slice(0, 200),
        qty: Number(p.qty ?? 1),
        price: Number(p.price ?? 0),
        discount: Number(p.discount ?? 0),
        order: i + 1,
        related_id: Number(p.document_product_id),
      };
      if (taxes && taxes.length > 0) line.taxes = taxes;
      // A 0% line must carry an exemption reason; prefer the document's own.
      else line.exemption_reason = p?.exemption_reason ?? resolveExemptionReason(ctx);
      return line;
    });

    if (products.some((p) => p.related_id == null || Number.isNaN(p.related_id))) {
      throw new Error(`Moloni credit failed: could not resolve related_id from source document ${invoiceId}`);
    }

    const gross = moloniDocTotal(source.doc) ?? products.reduce((acc, p) => acc + p.qty * p.price, 0);
    const needsExemption = products.some((p) => !p.taxes || p.taxes.length === 0);

    const payload: Record<string, unknown> = {
      document_set_id: cfg.documentSetId,
      customer_id: Number(source.doc.customer_id),
      date: todayYmd(),
      expiration_date: todayYmd(),
      our_reference: opts.reference,
      ...(opts.reason ? { notes: String(opts.reason).slice(0, 200) } : {}),
      products,
      status: 0,
      associated_documents: [{ associated_id: Number(invoiceId), value: gross }],
      ...(needsExemption ? { exemption_reason: resolveExemptionReason(ctx) } : {}),
    };

    if (opts.dryRun) {
      return { creditId: "", number: null, alreadyExisted: false, preview: payload };
    }

    const inserted = await moloniCall<{ document_id?: number }>(
      cfg, token, "/creditNotes/insert/", payload, "credit create",
    );
    const creditId = inserted?.document_id;
    if (!creditId) throw new Error(`Moloni credit create returned no document_id for ${invoiceId}`);

    // Close it: an open credit note has not undone anything.
    await moloniCall(cfg, token, "/creditNotes/update/", { document_id: Number(creditId), status: 1 }, "finalize");

    return { creditId: String(creditId), number: null, alreadyExisted: false };
  }

  async prepareFinalizeBatch(
    _ctx: AdapterCtx,
    _opts?: { strategy?: FinalizeDateStrategy },
  ): Promise<MoloniFinalizeBatch> {
    // Nothing to fetch: the floor is whatever Moloni tells us it is, on the
    // first close that hits it. One rejected close per run costs a round-trip
    // and writes nothing, which beats guessing the series state from a listing.
    return { kind: "moloni", seriesMinDate: null };
  }

  /**
   * Certify one draft, keeping it on the transaction's own date for as long as
   * Moloni allows.
   *
   * This used to be a bare `finalize()` on the strength of "Moloni fixes the
   * date at insert and never rejects a close". It does reject: closing is when
   * the document takes its place in the series, and a draft dated behind the
   * last CLOSED document is refused with `["12 date >= 2026-08-12"]`. So a bulk
   * run that closed a 12/08 sale first left every older draft in the batch
   * permanently un-certifiable, and `today` was no escape either, since the
   * strategy was never applied to the document at all.
   *
   * Re-dating a draft forward and noting the real transaction date in the
   * document is the correct fiscal handling of issuing today for a past
   * payment — the same thing `insertMoloniDoc` already does at insert.
   */
  async finalizeWithDate(
    invoiceId: string,
    ctx: AdapterCtx,
    opts: {
      strategy: FinalizeDateStrategy;
      batch?: FinalizeBatch;
      paidTotal?: number | null;
      dateMovedNote?: (originalDate: string) => string | null;
      dryRun?: boolean;
    },
  ): Promise<FinalizeOutcome> {
    const cfg = await getMoloniCfg(ctx);
    const token = await getAccessToken(cfg);

    // Resolve the document through whichever endpoint family holds it: tag
    // routing means an id stored on an invoice_receipt connection may live under
    // /invoices/, and update/close must be addressed to the same family.
    const found = await fetchMoloniDocument(cfg, token, invoiceId);
    if (!found) return { status: "error", message: `Documento ${invoiceId} não encontrado no Moloni` };
    if (Number(found.doc.status ?? 0) !== 0) {
      return { status: "skipped", message: `Já fechado (status=${found.doc.status})` };
    }
    const updatePath = found.path.replace(/getOne\/$/, "update/");

    // Closing is irreversible — a closed document is undone only with a credit
    // note — so a draft whose total is not what the buyer paid is never closed.
    const docTotal = moloniDocTotal(found.doc);
    const paid = opts.paidTotal;
    if (typeof paid === "number" && Number.isFinite(paid) && paid > 0
      && docTotal != null && Math.abs(docTotal - paid) > 0.011) {
      return {
        status: "error",
        message: `Total do documento (${docTotal.toFixed(2)}€) não é o valor pago (${paid.toFixed(2)}€) — não certifico`,
      };
    }

    const originalDate = typeof found.doc.date === "string" ? found.doc.date.slice(0, 10) : todayYmd();
    const batch = isMoloniBatch(opts.batch) ? opts.batch : null;
    const floor = batch?.seriesMinDate ?? null;
    // `today` never negotiates; every other strategy keeps the transaction's own
    // date and moves it forward only as far as the series forces.
    let targetDate = opts.strategy === "today"
      ? todayYmd()
      : (floor && floor > originalDate ? floor : originalDate);

    if (opts.dryRun) {
      // Advance the floor so the preview predicts the same dates the real run
      // would produce — otherwise the operator approves a run they won't get.
      if (batch) batch.seriesMinDate = laterYmd(batch.seriesMinDate, targetDate);
      return {
        status: "dry_run",
        date: targetDate,
        originalDate,
        message: targetDate === originalDate
          ? `Fecharia com a data da transacção (${formatPtYmd(originalDate)})`
          : `Mudaria a data ${formatPtYmd(originalDate)} → ${formatPtYmd(targetDate)} e fecharia`,
      };
    }

    let currentDate = originalDate;
    let lastError = "";
    // At most three passes: as issued, re-dated to the floor Moloni named, and
    // one more in case another document closed underneath us mid-run.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (targetDate !== currentDate) {
        try {
          await redateMoloniDraft(cfg, token, updatePath, {
            documentId: invoiceId,
            targetDate,
            originalDate,
            existingNotes: typeof found.doc.notes === "string" ? found.doc.notes : "",
            note: opts.dateMovedNote?.(originalDate) ?? null,
            expectedTotal: docTotal,
          });
        } catch (e) {
          return {
            status: "error",
            message: `Não consegui mudar a data para ${formatPtYmd(targetDate)}: ${String((e as { message?: string })?.message ?? e)}`,
          };
        }
        currentDate = targetDate;
      }

      try {
        await moloniCall(cfg, token, updatePath, { document_id: Number(invoiceId), status: 1 }, "finalize");
        if (batch) batch.seriesMinDate = laterYmd(batch.seriesMinDate, targetDate);
        return {
          status: "finalized",
          date: targetDate,
          originalDate,
          message: targetDate === originalDate
            ? `Fechado com a data da transacção (${formatPtYmd(originalDate)})`
            : `Fechado a ${formatPtYmd(targetDate)} — o Moloni recusou a data da transacção (${formatPtYmd(originalDate)}), que ficou anotada no documento`,
        };
      } catch (e) {
        lastError = String((e as { message?: string })?.message ?? e);
        const minDate = moloniSeriesMinDate(e);
        // Not a date complaint, or a floor we already tried: moving the date
        // again would not fix it, so leave the draft exactly as it is.
        if (!minDate || minDate <= targetDate) return { status: "error", message: lastError };
        if (batch) batch.seriesMinDate = laterYmd(batch.seriesMinDate, minDate);
        targetDate = minDate;
      }
    }

    return { status: "error", message: lastError || "Moloni recusou o fecho sem indicar uma data aceitável" };
  }

  /**
   * Record money received against a Fatura that is already closed, as a Recibo.
   *
   * This exists because a stay can be invoiced in full and paid in halves. The
   * Fatura states the debt on the day the booking is confirmed; each payment is
   * then recorded against it, which is what the merchant does by hand today and
   * what `reconciled_value` on the document reflects. A Fatura/Recibo cannot be
   * used for this: it asserts the money came in, and half of it had not.
   *
   * Idempotent by construction: the amount receipted is the difference between
   * what the source says has been collected and what Moloni has ALREADY
   * reconciled against this document — never a figure the caller tracked
   * separately. Two runs in a row therefore settle once, and the second reports
   * `skipped`. It is also why the read-back at the end is not optional: if
   * Moloni accepted the Recibo without reconciling it, the next run would
   * happily issue a second one.
   */
  async settleDocument(
    invoiceId: string,
    ctx: AdapterCtx,
    opts: {
      collected: number;
      date?: string | null;
      channelReference?: string | null;
      expectedReferences?: string[];
      notes?: string | null;
      dryRun?: boolean;
    },
  ): Promise<SettleOutcome> {
    const cfg = await getMoloniCfg(ctx);
    const token = await getAccessToken(cfg);

    const found = await fetchMoloniDocument(cfg, token, invoiceId);
    if (!found) {
      return {
        status: "error",
        code: "not_found",
        message: `Documento ${invoiceId} não encontrado no Moloni`,
        doc: { status: null, total: null, reconciled: null, missing: true },
      };
    }
    const doc = found.doc;
    const snapshot: SettleDocSnapshot = {
      status: doc.status == null ? null : Number(doc.status),
      total: moloniDocTotal(doc),
      reconciled: doc.reconciled_value == null ? null : Number(doc.reconciled_value),
    };

    // A Recibo is associated to a document, and Moloni only associates closed
    // ones — a draft has no number to point at. So this runs AFTER the finalize
    // pass, never as part of issuing.
    if (Number(doc.status ?? 0) !== 1) {
      return {
        status: "skipped",
        reason: "not_closed",
        message: `Documento ${invoiceId} não está fechado (status=${doc.status ?? "?"}) — um Recibo só se associa a um documento certificado`,
        doc: snapshot,
      };
    }

    // Only a FATURA is settled by a Recibo. `fetchMoloniDocument` walks the
    // families to find an id, so this can land on a Fatura-Recibo — a document
    // that already asserts the money arrived. One of those issued without a
    // payment method carries `reconciled_value` 0, which would read as "nothing
    // settled yet" and document the same money twice.
    if (!found.path.startsWith("/invoices/")) {
      return {
        status: "blocked",
        reason: "wrong_family",
        message: `Documento ${invoiceId} não é uma Fatura (${found.path}) — só uma Fatura se liquida com Recibo`,
        doc: snapshot,
      };
    }

    // Not in euros, or issued in a foreign currency: `moloniDocTotal` and the
    // amount Lodgify reports are then in different units, and the receipt insert
    // sends none of the exchange fields the invoice insert learned in July.
    if (doc.exchange_currency_id != null && Number(doc.exchange_currency_id) > 0) {
      return {
        status: "blocked",
        reason: "foreign_currency",
        message: `Documento ${invoiceId} está em moeda estrangeira — liquidação por Recibo não suportada`,
        doc: snapshot,
      };
    }

    // The document must be the one this booking's reference names. A wrong
    // `processed_orders.invoice_id` would otherwise settle a stranger's Fatura,
    // which is the fault class behind the August "Order #0" collision.
    const expected = (opts.expectedReferences ?? []).filter((r) => r && r.trim());
    const ourRef = String(doc.our_reference ?? "").trim();
    if (expected.length > 0 && ourRef && !expected.includes(ourRef)) {
      return {
        status: "blocked",
        reason: "reference_mismatch",
        message: `Documento ${invoiceId} tem a referência "${ourRef}", esperava ${expected.map((r) => `"${r}"`).join(" ou ")}`,
        doc: snapshot,
      };
    }

    const total = snapshot.total;
    if (total == null) {
      return {
        status: "error",
        code: "platform",
        message: `Não consigo ler o total do documento ${invoiceId} — não emito Recibo`,
        doc: snapshot,
      };
    }
    const settled = Number(doc.reconciled_value ?? 0);

    // More settled than the source says came in: a payment corrected downwards,
    // a refund, or a receipt issued by hand. Never unwound automatically — that
    // takes a human — but never silent either, which is what "Nada a liquidar"
    // made it.
    if (settled > opts.collected + 0.01) {
      return {
        status: "blocked",
        reason: "over_settled",
        message: `Documento ${invoiceId} está liquidado em ${settled.toFixed(2)}€ mas o Lodgify só regista `
          + `${opts.collected.toFixed(2)}€ recebidos — verificar à mão`,
        doc: snapshot,
      };
    }

    const value = receiptDelta({ collected: opts.collected, invoiceTotal: total, alreadySettled: settled });
    if (value <= 0) {
      return {
        status: "skipped",
        reason: "nothing_due",
        message: `Nada a liquidar em ${invoiceId}: recebido ${opts.collected.toFixed(2)}€, `
          + `já liquidado ${settled.toFixed(2)}€ de ${total.toFixed(2)}€`,
        doc: snapshot,
      };
    }

    // Never before the Fatura it settles, never in the future. The receipts
    // insert bypasses `insertMoloniDoc`, so it gets no series-floor retry: a
    // date Moloni refuses is simply a failed settlement, every pass.
    const docDate = typeof doc.date === "string" ? doc.date.slice(0, 10) : todayYmd();
    const asked = typeof opts.date === "string" && /^\d{4}-\d{2}-\d{2}/.test(opts.date)
      ? opts.date.slice(0, 10)
      : todayYmd();
    const today = todayYmd();
    const notBeforeInvoice = asked > docDate ? asked : docDate;
    const date = notBeforeInvoice > today ? today : notBeforeInvoice;

    if (opts.dryRun) {
      return {
        status: "dry_run",
        value,
        message: `Emitiria Recibo de ${value.toFixed(2)}€ a ${formatPtYmd(date)} sobre ${invoiceId} `
          + `(liquidado ${settled.toFixed(2)}€ de ${total.toFixed(2)}€)`,
        doc: snapshot,
      };
    }

    // How the money came in: the CHANNEL that collected it, first.
    //
    // Airbnb collected the guest's card, and "Airbnb" on the Recibo is what ties
    // it to the payout line in the bank. The configured `moloni_payment_method`
    // is the fallback, not the winner, and it has two jobs: a merchant whose
    // Moloni has no channel methods at all (Origos: Cheque / Multibanco /
    // Numerário / Transferência Bancária) and a DIRECT booking, which has no
    // channel by definition — a merchant with Airbnb and Booking methods still
    // needs an answer for the guest who booked on their own site.
    //
    // Preferring the channel is what makes both work at once. Config-first would
    // stamp one name on every Recibo, and forcing the channel would fail every
    // direct booking; either way a merchant has to choose which half is wrong.
    //
    // Nothing is guessed. Stamping "Numerário" on an Airbnb payout would be a
    // quiet lie in a fiscal document, so no method at all is an error that names
    // both ways to fix it.
    const channelMethod = paymentMethodNameFor({ channel_reference: opts.channelReference ?? null }, undefined);
    const configuredMethod = typeof ctx.destinationConfig?.moloni_payment_method === "string"
      && ctx.destinationConfig.moloni_payment_method.trim()
      ? String(ctx.destinationConfig.moloni_payment_method).trim()
      : null;

    let paymentMethodId = 0;
    if (channelMethod) {
      // A channel the merchant's account has no method for is not an error while
      // there is a fallback — plenty of accounts never created an "Airbnb".
      try {
        paymentMethodId = await resolvePaymentMethodId(cfg, token, channelMethod);
      } catch (e) {
        if (!configuredMethod) throw e;
        console.log(`[Moloni] no payment method named "${channelMethod}" — falling back to "${configuredMethod}"`);
      }
    }
    if (!paymentMethodId && configuredMethod) {
      paymentMethodId = await resolvePaymentMethodId(cfg, token, configuredMethod);
    }
    if (!paymentMethodId) {
      return {
        status: "error",
        code: "config",
        message: "Não sei como o dinheiro entrou: a reserva não traz canal e a ligação não tem "
          + "`moloni_payment_method`. Um Recibo tem de dizer o meio de pagamento.",
        doc: snapshot,
      };
    }

    const customerId = Number(doc.customer_id ?? 0);
    if (!customerId) {
      return {
        status: "error",
        code: "platform",
        message: `Documento ${invoiceId} não traz customer_id — não emito Recibo`,
        doc: snapshot,
      };
    }

    // The série the DOCUMENT carries, not the connection's: tag routing may have
    // sent it elsewhere, and the receipt belongs beside its invoice.
    const receiptSetId = await resolveReceiptDocumentSetId(
      cfg, token,
      typeof doc.document_set_name === "string" ? doc.document_set_name : null,
    );

    const inserted = await moloniCall<{ document_id?: number }>(
      cfg, token, MOLONI_RECEIPT_PATHS.insert,
      {
        document_set_id: receiptSetId,
        date,
        customer_id: customerId,
        net_value: value,
        status: 1,
        ...(opts.notes ? { notes: String(opts.notes).slice(0, 200) } : {}),
        payments: [{ payment_method_id: paymentMethodId, date, value }],
        associated_documents: [{ associated_id: Number(invoiceId), value }],
      },
      "create",
    );
    const receiptId = inserted?.document_id != null ? String(inserted.document_id) : "";
    if (!receiptId) {
      return {
        status: "error",
        code: "insert_unknown",
        message: `O Moloni aceitou o Recibo mas não devolveu document_id (${invoiceId}) — verificar antes de repetir`,
        doc: snapshot,
      };
    }

    // Did it actually settle? Moloni answering "valid" is not the same as the
    // invoice being reconciled, and an unreconciled invoice invites the next run
    // to issue a second Recibo for the same money.
    const after = await fetchMoloniDocument(cfg, token, invoiceId);
    const settledAfter = Number(after?.doc?.reconciled_value ?? 0);
    if (settledAfter < settled + value - 0.011) {
      return {
        status: "error",
        code: "not_reconciled",
        message: `Recibo ${receiptId} criado, mas o documento ${invoiceId} continua liquidado em `
          + `${settledAfter.toFixed(2)}€ (esperava ${(settled + value).toFixed(2)}€) — verificar à mão antes de repetir`,
        doc: { ...snapshot, reconciled: settledAfter },
      };
    }

    return {
      status: "settled",
      receiptId,
      value,
      settledTotal: settledAfter,
      doc: { ...snapshot, reconciled: settledAfter },
      message: `Recibo ${receiptId} de ${value.toFixed(2)}€ — documento liquidado em `
        + `${settledAfter.toFixed(2)}€ de ${total.toFixed(2)}€`,
    };
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

    // Source document's lines — needed BOTH for the required per-line related_id
    // and for the cash-delta VAT rate (below). Fetched once here.
    const [customerId, resolved, exchange, baseLines] = await Promise.all([
      resolveOrCreateCustomer(cfg, token, normalized),
      resolveProducts(cfg, token, refundItems, (it) => taxRateForItem(it, ctx), ctx.productMappings),
      resolveMoloniExchange(cfg, token, normalized.order.currency),
      fetchMoloniDocLines(cfg, token, invoiceId),
    ]);
    const baseRate = baseLines[0]?.tax_value ?? null;
    const baseTaxId = baseLines[0]?.tax_id ?? null;

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
      const lineTax = maxTaxLine?.taxes?.[0]?.value ?? 0;
      // Cash-ONLY refund (Stripe: no refund line items) has no line rate — take it
      // from the ORIGINAL document so the credit note carries its VAT (e.g. 23%)
      // instead of going out exempt. With real refund lines (Shopify) keep theirs.
      const rate = lineTax > 0 ? lineTax : (baseRate && baseRate > 0 ? baseRate : 0);
      const factor = rate > 0 ? 1 + rate / 100 : 1;
      const netUnit = Math.round((refund.amountToRefund / factor) * 10000) / 10000;
      const order = products.length + 1;
      // Cash-only refund delta has no source product. Ensure a synthetic
      // RIOKO-PLACEHOLDER product exists and reference it here. Resolve the rate
      // first so product creation doesn't throw when it came from a mapping.
      if (rate > 0) await ensureTaxIdsByRate(cfg, token, [rate]);
      const fallbackPid = await ensureMoloniProduct(
        cfg, token, FALLBACK_PLACEHOLDER_REFERENCE, "Rioko Refund Delta", rate,
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
      if (rate > 0) {
        const tid = (lineTax > 0 ? maxTaxLine?.taxes?.[0]?.tax_id : baseTaxId) ?? pickTaxId(cfg, rate);
        line.taxes = [{ tax_id: tid, value: rate, order: 1, cumulative: 0 }];
      } else {
        line.exemption_reason = resolveExemptionReason(ctx);
      }
      products.push(line);
    }

    if (products.length === 0) {
      throw new Error("Moloni credit create failed: no line items derived from refund");
    }

    // Source-of-truth guard (parity with createDraft and the IX refund path):
    // the credit-note gross MUST equal the amount actually refunded. issueCredit
    // historically had NO reconcile, so a mis-derived line (e.g. an inflated
    // cash-delta) would silently ship a fiscally-wrong credit note. Abort on
    // >1¢ drift → the queue retries / DLQ raises an incident instead.
    if (refund.grossAmount != null && refund.grossAmount > 0) {
      reconcileTotalOrThrow(
        refund.grossAmount,
        products.map((p) => ({
          name: p.name,
          quantity: Number(p.qty),
          unit_price: Number(p.price),
          tax_rate: Number(p.taxes?.[0]?.value ?? 0),
          discount_percent: Number(p.discount ?? 0),
        })),
        { context: `→Moloni credit OrderRefund#${refund.refundId}` },
      );
    }

    // Stamp the required per-line related_id (= the source invoice line's
    // document_product_id). Match each credit line to the base line by
    // product_id; the free-form cash-delta line (placeholder product) and any
    // unmatched line fall back to the first base line — Moloni only needs a
    // valid document_product_id from the associated document, not an exact map.
    // (baseLines was fetched once above, reused here.)
    const relatedByProduct = new Map<number, number>();
    for (const bl of baseLines) {
      if (bl?.product_id != null && bl?.document_product_id != null && !relatedByProduct.has(Number(bl.product_id))) {
        relatedByProduct.set(Number(bl.product_id), Number(bl.document_product_id));
      }
    }
    const fallbackRelated = baseLines[0]?.document_product_id != null ? Number(baseLines[0].document_product_id) : undefined;
    for (const p of products) {
      p.related_id = (p.product_id != null ? relatedByProduct.get(Number(p.product_id)) : undefined) ?? fallbackRelated;
    }
    if (products.some((p) => p.related_id == null)) {
      throw new Error(`Moloni credit create failed: could not resolve related_id from source document ${invoiceId} (deleted or has no lines)`);
    }

    const exemptionReason = resolveExemptionReason(ctx);
    const needsExemption = products.some((p) => !p.taxes || p.taxes.length === 0);

    const payload: Record<string, unknown> = {
      document_set_id: cfg.documentSetId,
      customer_id: customerId,
      date: todayYmd(),
      expiration_date: todayYmd(),
      our_reference: refundReference(refund.refundId),
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
