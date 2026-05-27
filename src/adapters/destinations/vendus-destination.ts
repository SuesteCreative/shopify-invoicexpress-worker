import type {
  DestinationAdapter,
  AdapterCtx,
  DestinationInvoiceCreateResult,
  DestinationCreditResult,
  NormalizedRefund,
} from "../types";
import type { Normalized } from "../../api/normalize-shopify";
import { reconcileTotalOrThrow } from "../reconcile";

// -----------------------------------------------------------------------------
// VendusDestination — Cegid Vendus v1.1
//
// Adapter for Vendus (https://www.vendus.pt). Implements the
// `DestinationAdapter` contract.
//
// MODEL DIFFERENCES vs IX (important):
//  * Vendus has NO draft → finalize transition. `POST /documents/` issues the
//    document immediately and irrevocably (assigns number, hash, ATCUD).
//    Consequence:
//      - `createDraft` posts with `mode: "normal"` and returns the new id.
//      - `finalize` is a no-op (the document is already final).
//    The generic-pipeline.ts already supports this shape via the
//    `finalizeInSameFlow` branch used for Stripe. Vendus is functionally
//    equivalent but auto-finalize is owned here in the destination rather than
//    being a pipeline branch — for now `finalize()` simply returns.
//  * `mode` only accepts `"normal"` or `"tests"`. NEVER `"draft"`.
//  * Credit notes (NC) link to the original PER-ITEM, not document-level.
//    Each NC item carries
//        reference_document: { document_number, document_row }
//    where `document_number` is the original `number` (e.g. "FT 01P2026/220")
//    and `document_row` is the 1-based row index in the original items array.
//  * Document types are codes: FT, FS, FR, NC, FG, ND. NEVER `FT-FR`.
//  * Status transitions (rarely needed in our flow) are via PATCH with
//    body `{ status: "N" | "A" | "F", stock, mode }` — N=Normal, A=Canceled,
//    F=Invoiced.
//  * Authentication: HTTP Basic, `Authorization: Basic base64(apiKey + ":")`.
//    POST/PATCH require Content-Type: application/json or Vendus returns 415.
//
// The literal "vendus" kind is not yet in the `DestinationKind` union in
// ../types.ts — the coordinator widens the union when wiring this adapter in.
// -----------------------------------------------------------------------------

type VendusEnv = "production" | "sandbox";

type VendusConfig = {
  vendus_api_key: string;
  vendus_register_id?: string | number;
  vendus_series_id?: string | number;
  vendus_environment?: VendusEnv;
  ix_document_type?: string;
  ix_exemption_reason?: string;
  ix_email_subject?: string;
  ix_email_body?: string;
};

interface VendusReferenceDocument {
  document_number: string;
  document_row: number;
}

interface VendusItem {
  id?: number;
  reference?: string;
  qty: number;
  title: string;
  gross_price: number;
  tax_id?: "NOR" | "INT" | "RED" | "ISE" | "OUT";
  tax_exemption?: string;
  discount_amount?: number;
  discount_percentage?: number | string;
  type_id?: "P" | "S" | "O" | "I" | "E";
  stock_control?: number;
  reference_document?: VendusReferenceDocument;
}

interface VendusClientPayload {
  name: string;
  email?: string;
  fiscal_id?: string;
  address?: string;
  city?: string;
  postalcode?: string;
  country?: string; // 2-letter ISO code, e.g. "PT"
  phone?: string;
  external_reference?: string;
}

interface VendusDocumentResponse {
  id: number | string;
  type?: string;
  number?: string;
  date?: string;
  amount_gross?: number;
  amount_net?: number;
  hash?: string;
  atcud?: string;
  client?: VendusClientPayload & { email?: string };
  items?: Array<{
    id?: number | string;
    reference?: string;
    title?: string;
    qty?: number;
    gross_price?: number;
    [k: string]: unknown;
  }>;
  [k: string]: unknown;
}

function readVendusConfig(ctx: AdapterCtx): VendusConfig {
  // Credentials live in `connections.destination_config_json`. Behavior toggles
  // (ix_document_type, ix_exemption_reason, ix_email_*) still live in the
  // legacy `integrations` row and apply across destinations.
  const dest = (ctx.destinationConfig ?? {}) as Record<string, unknown>;
  const legacy = ctx.config as unknown as Record<string, unknown>;
  const apiKey = dest.vendus_api_key;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new Error("Vendus config missing: vendus_api_key");
  }
  return {
    vendus_api_key: apiKey,
    vendus_register_id: (dest.vendus_register_id as string | number | undefined) ?? undefined,
    vendus_series_id: (dest.vendus_series_id as string | number | undefined) ?? undefined,
    vendus_environment: (dest.vendus_environment as VendusEnv | undefined) ?? "production",
    ix_document_type: (legacy.ix_document_type as string | undefined) ?? undefined,
    ix_exemption_reason: (legacy.ix_exemption_reason as string | undefined) ?? undefined,
    ix_email_subject: (legacy.ix_email_subject as string | undefined) ?? undefined,
    ix_email_body: (legacy.ix_email_body as string | undefined) ?? undefined,
  };
}

function baseUrl(cfg: VendusConfig): string {
  // TODO: UNVERIFIED — the sandbox host `sandbox.vendus.pt` is not explicitly
  // documented in the public v1.1 reference. If sandbox is disabled by Vendus,
  // fall back to production with a dedicated test account using `mode: "tests"`.
  return cfg.vendus_environment === "sandbox"
    ? "https://sandbox.vendus.pt/ws/v1.1"
    : "https://www.vendus.pt/ws/v1.1";
}

function authHeader(cfg: VendusConfig): string {
  // HTTP Basic: api_key as the username, empty password.
  const token = btoa(`${cfg.vendus_api_key}:`);
  return `Basic ${token}`;
}

async function vendusFetch<T = unknown>(
  cfg: VendusConfig,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: T | null; raw: string }> {
  const url = `${baseUrl(cfg)}${path}`;
  const init: RequestInit = {
    method,
    headers: {
      "Authorization": authHeader(cfg),
      "Accept": "application/json",
      // Vendus returns 415 for POST/PATCH without an explicit JSON content-type.
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };

  const res = await fetch(url, init);
  const raw = await res.text();
  let parsed: T | null = null;
  if (raw.length > 0) {
    try { parsed = JSON.parse(raw) as T; } catch { parsed = null; }
  }
  return { ok: res.ok, status: res.status, data: parsed, raw };
}

// Map a numeric VAT rate to Vendus tax id codes.
// TODO: this covers PT continental only. Açores (4 / 9 / 16) and Madeira
// (4 / 9 / 22) need region-specific overrides driven by a config-mapping
// (e.g. tax_region: "PT-20" | "PT-30") because RED/INT/NOR are register-bound
// to the rate configured for that register in Vendus.
function vendusTaxId(rate: number): "NOR" | "INT" | "RED" | "ISE" | "OUT" {
  if (rate === 0) return "ISE";
  if (rate === 6) return "RED";
  if (rate === 13) return "INT";
  if (rate === 23) return "NOR";
  return "OUT";
}

function pickInvoiceAddress(normalized: Normalized) {
  // IX-compatible priority: billing first, then shipping fallback. See
  // memory:rioko-invoice-address-priority.
  const customer = normalized.order.customer;
  return {
    ...customer?.default_address ?? {},
    ...normalized.order.shipping_address ?? {},
    ...customer?.address ?? {},
    ...normalized.order.billing_address ?? {},
  };
}

function buildClient(normalized: Normalized): VendusClientPayload {
  const order = normalized.order;
  const customer = order.customer;
  const address = pickInvoiceAddress(normalized) as Record<string, unknown>;

  // PT NIF often arrives in address2 (see IxBuilder convention).
  const rawFiscal = typeof address.address2 === "string" ? address.address2.trim() : "";
  const fiscalId = rawFiscal.length > 0 ? rawFiscal : undefined;

  const name = (
    customer?.name
    || (typeof address.name === "string" ? address.name : "")
    || "Consumidor final"
  ).trim().slice(0, 200);

  const out: VendusClientPayload = {
    name,
  };
  if (customer?.email) out.email = customer.email;
  if (fiscalId) out.fiscal_id = fiscalId;
  if (typeof address.address1 === "string") out.address = address.address1;
  if (typeof address.city === "string") out.city = address.city;
  if (typeof address.zip === "string") out.postalcode = address.zip;
  if (typeof address.country_code === "string") out.country = address.country_code;
  if (typeof address.phone === "string") out.phone = address.phone;
  if (customer?.id !== undefined && customer?.id !== null) {
    out.external_reference = String(customer.id);
  }
  return out;
}

function lineTitle(item: Normalized["order"]["items"][number]): string {
  const isShipping = !item.product_id && !item.variant_id;
  if (isShipping) {
    return `Portes de envio${item.title ? ` — ${item.title}` : ""}`.slice(0, 200);
  }
  if (item.variant_title) {
    return `${item.title} / ${item.variant_title}`.slice(0, 200);
  }
  return (item.title ?? "Item").slice(0, 200);
}

function buildItem(
  normalizedItem: Normalized["order"]["items"][number],
  cfg: VendusConfig,
): VendusItem {
  const rate = normalizedItem.tax?.unit_amount === 0
    ? 0
    : Number(normalizedItem.tax?.value ?? 0);
  const tax_id = vendusTaxId(rate);

  // Vendus `gross_price` is the unit price INCLUDING VAT. The normalized
  // convention is `unit_price` = NET (VAT-exclusive), so we add VAT here.
  // Tax-exempt lines (rate=0) skip the conversion.
  const netUnit = Number(normalizedItem.unit_price) || 0;
  const grossUnit = rate > 0 ? netUnit * (1 + rate / 100) : netUnit;

  const out: VendusItem = {
    qty: normalizedItem.quantity,
    title: lineTitle(normalizedItem),
    gross_price: Math.round(grossUnit * 100) / 100,
    tax_id,
    type_id: "P",
    stock_control: 0,
  };
  if (normalizedItem.sku) out.reference = normalizedItem.sku;

  if (tax_id === "ISE") {
    out.tax_exemption = cfg.ix_exemption_reason ?? "M40";
  }

  // Discounts: prefer monetary allocation if present; otherwise pass percentage.
  const allocation = typeof normalizedItem.discount_allocation_amount === "number"
    ? normalizedItem.discount_allocation_amount
    : 0;
  if (allocation > 0) {
    out.discount_amount = Math.round(allocation * 100) / 100;
  } else if (normalizedItem.discount?.percent) {
    out.discount_percentage = normalizedItem.discount.percent;
  }

  return out;
}

function buildItems(normalized: Normalized, cfg: VendusConfig): VendusItem[] {
  return normalized.order.items.map(it => buildItem(it, cfg));
}

function mapIxDocType(cfg: VendusConfig): "FT" | "FR" {
  return cfg.ix_document_type === "invoice_receipt" ? "FR" : "FT";
}

function extractDoc(data: unknown): VendusDocumentResponse | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  if ("data" in obj && obj.data && typeof obj.data === "object") {
    return obj.data as VendusDocumentResponse;
  }
  if ("id" in obj) return obj as VendusDocumentResponse;
  return null;
}

function extractDocId(data: unknown): string | null {
  const doc = extractDoc(data);
  if (!doc) return null;
  const id = doc.id;
  return id !== undefined && id !== null ? String(id) : null;
}

// Find the 1-based row index of the refund item inside the original document.
// Matches first by `reference` (SKU), then by `title`.
function findOriginalRow(
  originalItems: NonNullable<VendusDocumentResponse["items"]>,
  refundItem: Normalized["order"]["items"][number],
): number | null {
  const sku = refundItem.sku?.trim();
  if (sku) {
    const idx = originalItems.findIndex(it => (it.reference ?? "").trim() === sku);
    if (idx >= 0) return idx + 1;
  }
  const wanted = lineTitle(refundItem).trim();
  if (wanted) {
    const idx = originalItems.findIndex(it => (it.title ?? "").trim() === wanted);
    if (idx >= 0) return idx + 1;
  }
  return null;
}

export class VendusDestination implements DestinationAdapter {
  readonly kind = "vendus" as const;

  async findByReference(reference: string, ctx: AdapterCtx): Promise<{ id: string } | null> {
    // NOTE: Vendus's `?reference=` filter is documented to substring-match
    // against the document's stored `reference`. IX-style refund references
    // such as "OrderRefund #123" may collide with the parent order if both
    // share the same prefix — coordinator should treat duplicates as
    // suspicious rather than authoritative.
    const cfg = readVendusConfig(ctx);
    const path = `/documents/?reference=${encodeURIComponent(reference)}`;
    const { ok, data } = await vendusFetch<VendusDocumentResponse[] | { data: VendusDocumentResponse[] }>(
      cfg, "GET", path,
    );
    if (!ok || !data) return null;
    const list: VendusDocumentResponse[] = Array.isArray(data)
      ? data
      : Array.isArray((data as { data?: VendusDocumentResponse[] }).data)
        ? (data as { data: VendusDocumentResponse[] }).data
        : [];
    const first = list[0];
    if (!first) return null;
    return { id: String(first.id) };
  }

  async createDraft(normalized: Normalized, ctx: AdapterCtx): Promise<DestinationInvoiceCreateResult> {
    const cfg = readVendusConfig(ctx);
    const client = buildClient(normalized);
    const items = buildItems(normalized, cfg);
    const type = mapIxDocType(cfg);

    // Source-of-truth invariant: invoice gross MUST equal source paid amount.
    // Vendus `gross_price` is already VAT-inclusive, so reconcile against the
    // gross form (tax_rate=0) to mirror Vendus's internal computation.
    reconcileTotalOrThrow(
      Number(normalized.order.total),
      items.map((it) => ({
        name: it.title,
        quantity: Number(it.qty),
        unit_price: Number(it.gross_price),
        tax_rate: 0,
        discount_amount: Number(it.discount_amount ?? 0),
        discount_percent: Number(it.discount_percentage ?? 0),
      })),
      { context: `→Vendus order#${normalized.order.order_number}` },
    );

    const body: Record<string, unknown> = {
      type,                 // "FT" or "FR"
      mode: "normal",       // Vendus has no "draft" — see file header.
      date: normalized.order.created_at,
      reference: normalized.order.reference || `Order #${normalized.order.order_number}`,
      client,
      items,
    };
    if (cfg.vendus_register_id !== undefined) body.register_id = cfg.vendus_register_id;
    if (cfg.vendus_series_id !== undefined) body.serie = cfg.vendus_series_id; // Vendus uses `serie`, not `series_id`.

    const noteRaw = (normalized.order as { note?: unknown }).note;
    if (typeof noteRaw === "string" && noteRaw.length > 0) {
      body.notes = noteRaw.slice(0, 200);
    }

    const { ok, status, data, raw } = await vendusFetch<VendusDocumentResponse | { data: VendusDocumentResponse }>(
      cfg, "POST", "/documents/", body,
    );
    if (!ok) {
      throw new Error(`Vendus create failed: status=${status} body=${raw.slice(0, 500)}`);
    }
    const id = extractDocId(data);
    if (!id) {
      throw new Error(`Vendus create failed: no id returned. body=${raw.slice(0, 500)}`);
    }
    // NOTE: response also carries number/hash/atcud — we discard them because
    // the DestinationAdapter contract only returns `invoiceId`. `issueCredit`
    // will GET the document again to retrieve `number`.
    return { invoiceId: id };
  }

  async finalize(_invoiceId: string, _ctx: AdapterCtx): Promise<void> {
    // No-op. Vendus issues documents immediately on POST — no draft/final state.
    return;
  }

  async issueCredit(
    invoiceId: string,
    refund: NormalizedRefund,
    normalized: Normalized,
    ctx: AdapterCtx,
  ): Promise<DestinationCreditResult> {
    const cfg = readVendusConfig(ctx);

    // Fetch the original to obtain `number` and `items[]` row positions.
    const get = await vendusFetch<VendusDocumentResponse | { data: VendusDocumentResponse }>(
      cfg, "GET", `/documents/${encodeURIComponent(invoiceId)}/`,
    );
    if (!get.ok || !get.data) {
      throw new Error(`Vendus credit create failed: cannot fetch original ${invoiceId}: status=${get.status} body=${get.raw.slice(0, 500)}`);
    }
    const original = extractDoc(get.data);
    const originalNumber = original?.number;
    const originalItems = original?.items ?? [];
    if (!originalNumber) {
      throw new Error(`Vendus credit create failed: original document has no number. id=${invoiceId}`);
    }

    const client = buildClient(normalized);
    const refundItems = normalized.order.items.filter(it => refund.itemsIds.includes(it.id));

    const items: VendusItem[] = [];
    for (const refundItem of refundItems) {
      const line = buildItem(refundItem, cfg);
      const row = findOriginalRow(originalItems, refundItem);
      if (row === null) {
        throw new Error(
          `Vendus credit create failed: cannot map refund item to original row. ` +
          `original=${originalNumber} sku=${refundItem.sku ?? ""} title=${lineTitle(refundItem)}`,
        );
      }
      line.reference_document = { document_number: originalNumber, document_row: row };
      items.push(line);
    }

    // Amount-only refunds: attach to row 1 as a single adjustment line.
    // UNVERIFIED — confirm whether Vendus accepts an NC item whose monetary
    // value exceeds the referenced original row. If it rejects, the coordinator
    // must split into per-row credits.
    if (refund.amountToRefund > 0 && items.length === 0) {
      items.push({
        qty: 1,
        title: `Refund amount (#${refund.refundId})`,
        gross_price: refund.amountToRefund,
        tax_id: "ISE",
        tax_exemption: cfg.ix_exemption_reason ?? "M40",
        type_id: "O",
        stock_control: 0,
        reference_document: { document_number: originalNumber, document_row: 1 },
      });
    }

    const body: Record<string, unknown> = {
      type: "NC",
      mode: "normal",
      date: new Date().toISOString().slice(0, 10),
      reference: `OrderRefund #${refund.refundId}`,
      client,
      items,
    };
    if (cfg.vendus_register_id !== undefined) body.register_id = cfg.vendus_register_id;
    if (cfg.vendus_series_id !== undefined) body.serie = cfg.vendus_series_id;

    const { ok, status, data, raw } = await vendusFetch<VendusDocumentResponse | { data: VendusDocumentResponse }>(
      cfg, "POST", "/documents/", body,
    );
    if (!ok) {
      throw new Error(`Vendus credit create failed: status=${status} body=${raw.slice(0, 500)}`);
    }
    const creditId = extractDocId(data);
    if (!creditId) {
      throw new Error(`Vendus credit create failed: no id returned. body=${raw.slice(0, 500)}`);
    }
    return { creditId };
  }

  async emailDocument(invoiceId: string, ctx: AdapterCtx): Promise<void> {
    const cfg = readVendusConfig(ctx);

    // Look up client email from the document.
    const get = await vendusFetch<VendusDocumentResponse | { data: VendusDocumentResponse }>(
      cfg, "GET", `/documents/${encodeURIComponent(invoiceId)}/`,
    );
    if (!get.ok || !get.data) {
      throw new Error(`Vendus email failed (fetch): status=${get.status} body=${get.raw.slice(0, 500)}`);
    }
    const doc = extractDoc(get.data);
    const to = doc?.client?.email;
    if (!to) return; // mirror IX: silently skip when no email on file

    // UNVERIFIED — the /communications/ endpoint and the `method`/`to` field
    // names are inferred from related Vendus public references; the v1.1
    // documents.doc page does not enumerate the communications schema. Confirm
    // by inspecting the live API response in sandbox.
    const body: Record<string, unknown> = {
      method: "email",
      to,
    };
    if (cfg.ix_email_subject) body.subject = cfg.ix_email_subject;
    if (cfg.ix_email_body) body.message = cfg.ix_email_body;

    const { ok, status, raw } = await vendusFetch(
      cfg, "POST", `/documents/${encodeURIComponent(invoiceId)}/communications/`, body,
    );
    if (!ok) {
      throw new Error(`Vendus email failed: status=${status} body=${raw.slice(0, 500)}`);
    }
  }
}
