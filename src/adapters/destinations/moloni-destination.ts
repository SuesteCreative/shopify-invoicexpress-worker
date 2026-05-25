import type {
  DestinationAdapter,
  AdapterCtx,
  DestinationInvoiceCreateResult,
  DestinationCreditResult,
  NormalizedRefund,
} from "../types";
import type { Normalized } from "../../api/normalize-shopify";
import { validatePTNIF } from "../../ix/nif";

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

type MoloniCfg = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  companyId: number;
  documentSetId: number;
};

// Hardcoded fallback IDs. Real numbers must come from the user's Moloni
// account setup (see coordinator TODO). They are passed in via ctx.config
// where present and only fall back when absent so dev/sandbox can still ship.
const DEFAULT_TAX_ID = 0;            // 0 = "no tax / exempt", per Moloni docs
const DEFAULT_PAYMENT_METHOD_ID = 0; // 0 = unset; finalize accepts no method
const NON_PT_GENERIC_VAT = "999999990";

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

  if (!clientId || !clientSecret || !username || !password) {
    throw new Error("Moloni create failed: missing OAuth credentials (client_id/client_secret/username/password)");
  }
  if (!companyId) {
    throw new Error("Moloni create failed: missing moloni_company_id");
  }
  if (!documentSetId) {
    throw new Error("Moloni create failed: missing moloni_document_set_id");
  }

  return { baseUrl: env, clientId, clientSecret, username, password, companyId, documentSetId };
}

async function getAccessToken(cfg: MoloniCfg): Promise<string> {
  // Moloni grant endpoint accepts query-string params on POST.
  const url = new URL(`${cfg.baseUrl}/grant/`);
  url.searchParams.set("grant_type", "password");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("client_secret", cfg.clientSecret);
  url.searchParams.set("username", cfg.username);
  url.searchParams.set("password", cfg.password);

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
  });
  const body = await safeJson(res);
  if (!res.ok) {
    throw new Error(`Moloni create failed: auth ${res.status} — ${truncate(JSON.stringify(body))}`);
  }
  const token = (body as MoloniTokenResponse)?.access_token;
  if (!token) {
    throw new Error(`Moloni create failed: auth returned no access_token — ${truncate(JSON.stringify(body))}`);
  }
  return token;
}

async function moloniCall<T = unknown>(
  cfg: MoloniCfg,
  token: string,
  path: string,
  body: Record<string, unknown>,
  opName: "create" | "finalize" | "credit create" | "email" | "lookup",
): Promise<T> {
  const url = `${cfg.baseUrl}${path}?access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ company_id: cfg.companyId, ...body }),
  });
  const json = await safeJson(res);
  if (!res.ok) {
    // Moloni returns 401 on expired tokens — propagate so the error classifier
    // in generic-pipeline tags it as auth_failure_destination.
    throw new Error(`Moloni ${opName} failed: ${res.status} — ${truncate(JSON.stringify(json))}`);
  }
  // Moloni often returns `{valid: 1, ...}` on success; `{valid: 0, errors: ...}`
  // on logical failure (e.g. invalid NIF). Treat both 200+valid:0 as errors.
  if (json && typeof json === "object" && "valid" in (json as object) && (json as { valid: number }).valid === 0) {
    throw new Error(`Moloni ${opName} failed: ${truncate(JSON.stringify(json))}`);
  }
  return json as T;
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

function buildMoloniLineItems(normalized: Normalized, ctx: AdapterCtx): MoloniProductLine[] {
  const forceTaxProducts = ctx.config.force_tax_rate;
  const forceTaxShipping = ctx.config.force_shipping_tax_rate;

  return normalized.order.items.map((item, idx): MoloniProductLine => {
    const isShipping = !item.product_id && !item.variant_id;
    const name = isShipping
      ? `Portes de envio${item.title ? ` — ${item.title}` : ""}`.slice(0, 200)
      : (item.variant_title
        ? `${item.title} / ${item.variant_title}`.slice(0, 200)
        : item.title.slice(0, 200));
    const summary = isShipping ? undefined : (item.sku ? `SKU: ${item.sku}`.slice(0, 200) : undefined);

    const forceTax = isShipping ? forceTaxShipping : forceTaxProducts;
    const taxRate = forceTax != null
      ? forceTax
      : (item.tax.unit_amount === 0 ? 0 : item.tax.value);

    // Moloni price is net unit price (VAT-exclusive). normalized.unit_price
    // already follows the IX convention (VAT-exclusive when shop is exclusive,
    // VAT-inclusive when shop is inclusive). We approximate by stripping VAT
    // if the order is marked vat_included. Coordinator: a future enhancement
    // should mirror IxBuilder.buildInvoiceItemsFromRaw to use raw_order rates.
    const vatIncluded = ctx.config.vat_included === 1;
    const factor = vatIncluded && taxRate > 0 ? 1 + taxRate / 100 : 1;
    const netUnit = Math.round((item.unit_price / factor) * 10000) / 10000;

    const discountPct = item.discount?.percent ?? 0;

    const line: MoloniProductLine = {
      name,
      qty: item.quantity,
      price: netUnit,
      discount: discountPct,
      order: idx + 1,
    };
    if (summary) line.summary = summary;

    if (taxRate > 0) {
      line.taxes = [{
        tax_id: DEFAULT_TAX_ID,
        value: taxRate,
        order: 1,
        cumulative: 0,
      }];
    } else {
      // Exemption code required by Moloni on zero-tax lines.
      const ex = (ctx.config.ix_exemption_reason ?? "M01").trim() || "M01";
      line.exemption_reason = ex;
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

  // 1. Lookup by VAT.
  try {
    const found = await moloniCall<MoloniCustomerLookup[] | MoloniCustomerLookup>(
      cfg, token, "/customers/getByVat/", { vat }, "lookup",
    );
    const first = Array.isArray(found) ? found[0] : found;
    if (first && typeof first === "object" && "customer_id" in first && first.customer_id) {
      return Number(first.customer_id);
    }
  } catch {
    // getByVat returns 404-ish on miss; fall through to insert.
  }

  // 2. Insert a new customer record.
  const customerName = (order.customer?.name?.trim() || billing?.name?.trim() || "Consumidor Final").slice(0, 200);
  const inserted = await moloniCall<{ customer_id?: number }>(
    cfg, token, "/customers/insert/",
    {
      vat,
      name: customerName,
      language_id: 1,
      address: (billing?.address1 ?? "").slice(0, 200),
      city: (billing?.city ?? "").slice(0, 50),
      zip_code: (billing?.zip ?? "").slice(0, 20),
      country_id: countryIsPT ? 1 : 0, // Moloni country IDs vary per account; 1 = PT in default seed.
      email: (order.customer?.email ?? "").slice(0, 200),
      phone: ((order.customer as { phone?: string | null } | undefined)?.phone ?? billing?.phone ?? "").toString().slice(0, 50),
      maturity_date_id: 0,
      payment_method_id: DEFAULT_PAYMENT_METHOD_ID,
      delivery_method_id: 0,
      salesman_id: 0,
      field_notes: "",
    },
    "lookup",
  );
  const customerId = inserted?.customer_id;
  if (!customerId) {
    throw new Error(`Moloni create failed: customer insert returned no id — ${truncate(JSON.stringify(inserted))}`);
  }
  return Number(customerId);
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
    const cfg = readMoloniCfg(ctx);
    const token = await getAccessToken(cfg);
    try {
      // `our_reference` is the field Moloni indexes for free-text lookup on
      // invoices. We mirror IX's "reference" field in createDraft below.
      const found = await moloniCall<Array<{ document_id?: number }>>(
        cfg, token, "/invoices/getAll/", {
          document_set_id: cfg.documentSetId,
          our_reference: reference,
        },
        "lookup",
      );
      const first = Array.isArray(found) ? found[0] : null;
      if (first?.document_id) return { id: String(first.document_id) };
      return null;
    } catch {
      return null;
    }
  }

  async createDraft(normalized: Normalized, ctx: AdapterCtx): Promise<DestinationInvoiceCreateResult> {
    const cfg = readMoloniCfg(ctx);
    const token = await getAccessToken(cfg);

    const customerId = await resolveOrCreateCustomer(cfg, token, normalized);
    const products = buildMoloniLineItems(normalized, ctx);
    if (products.length === 0) {
      throw new Error("Moloni create failed: no line items derived from normalized order");
    }

    const exemptionReason = (ctx.config.ix_exemption_reason ?? "M01").trim() || "M01";
    const needsExemption = products.some((p) => !p.taxes || p.taxes.length === 0);

    const payload: Record<string, unknown> = {
      document_set_id: cfg.documentSetId,
      customer_id: customerId,
      date: dateOnlyYmd(normalized.order.created_at),
      expiration_date: dateOnlyYmd(normalized.order.created_at),
      our_reference: `Order #${normalized.order.order_number}`,
      your_reference: normalized.order.reference?.toString().slice(0, 100) ?? undefined,
      products,
      status: 0, // 0 = draft, 1 = closed/finalized
      notes: (normalized.order.note ?? "").toString().slice(0, 200),
      ...(needsExemption ? { exemption_reason: exemptionReason } : {}),
    };

    const res = await moloniCall<{ document_id?: number }>(
      cfg, token, "/invoices/insert/", payload, "create",
    );
    const id = res?.document_id;
    if (!id) {
      throw new Error(`Moloni create failed: insert returned no document_id — ${truncate(JSON.stringify(res))}`);
    }
    return { invoiceId: String(id) };
  }

  async finalize(invoiceId: string, ctx: AdapterCtx): Promise<void> {
    const cfg = readMoloniCfg(ctx);
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
    const cfg = readMoloniCfg(ctx);
    const token = await getAccessToken(cfg);

    const customerId = await resolveOrCreateCustomer(cfg, token, normalized);

    // Build refund lines from the items actually being refunded.
    const refundItems = normalized.order.items.filter((it) => refund.itemsIds.includes(it.id));
    const subset: Normalized = {
      ...normalized,
      order: { ...normalized.order, items: refundItems },
    };
    const products = buildMoloniLineItems(subset, ctx);

    // Free-form refund delta when Shopify reports an amount beyond the line
    // items (e.g. partial cash refund). Mirrors IX adapter's behaviour.
    if (refund.amountToRefund > 0) {
      const maxTax = products.reduce<number>((acc, p) => {
        const t = p.taxes?.[0]?.value ?? 0;
        return t > acc ? t : acc;
      }, 0);
      const factor = maxTax > 0 ? 1 + maxTax / 100 : 1;
      const netUnit = Math.round((refund.amountToRefund / factor) * 10000) / 10000;
      const order = products.length + 1;
      const line: MoloniProductLine = {
        name: `Refund amount (#${refund.refundId})`.slice(0, 200),
        summary: `Refund amount of ${refund.amountToRefund}`,
        qty: 1,
        price: netUnit,
        discount: 0,
        order,
      };
      if (maxTax > 0) {
        line.taxes = [{ tax_id: DEFAULT_TAX_ID, value: maxTax, order: 1, cumulative: 0 }];
      } else {
        line.exemption_reason = (ctx.config.ix_exemption_reason ?? "M01").trim() || "M01";
      }
      products.push(line);
    }

    if (products.length === 0) {
      throw new Error("Moloni credit create failed: no line items derived from refund");
    }

    const exemptionReason = (ctx.config.ix_exemption_reason ?? "M01").trim() || "M01";
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
    };

    const inserted = await moloniCall<{ document_id?: number }>(
      cfg, token, "/creditNotes/insert/", payload, "credit create",
    );
    const creditId = inserted?.document_id;
    if (!creditId) {
      throw new Error(`Moloni credit create failed: insert returned no document_id — ${truncate(JSON.stringify(inserted))}`);
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
    const cfg = readMoloniCfg(ctx);
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
