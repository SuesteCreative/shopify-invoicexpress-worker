import type { Normalized } from "../api/normalize-shopify";
import type { IRequestConfig } from "../storage";

export type SourceKind = "shopify" | "stripe" | "eupago";
export type DestinationKind = "invoicexpress" | "moloni" | "vendus";

export interface AdapterCtx {
  apiKey: string;
  config: IRequestConfig;
  // Parsed `connections.source_config_json` for the active connection. Lets the
  // source adapter pull source-specific credentials (e.g. Stripe restricted_key
  // to expand Customer.tax_ids) without re-querying the DB.
  sourceConfig?: Record<string, any>;
  // Parsed `connections.destination_config_json`. Holds destination-specific
  // credentials and settings (Moloni OAuth, Vendus API key, etc.). Behavior
  // toggles (auto_finalize, ix_send_email, ix_exemption_reason fallback) still
  // live in `config` (legacy `integrations` row) until Phase 5 projects them.
  destinationConfig?: Record<string, any>;
  // Pre-fetched explicit product mappings, keyed by source_reference
  // (output of MoloniDestination.deriveProductReference). Adapters consult
  // this Map before falling back to the find-or-create-by-reference path.
  productMappings?: Map<string, number>;
  // Pre-fetched per-SKU overrides (tax_rate, vat_inclusion, exemption,
  // name). Used by IxBuilder.buildInvoiceItemsFromRaw to adjust per-line
  // behavior without touching the integration-level config.
  productOverrides?: Map<string, {
    tax_rate?: number;
    vat_inclusion?: "inc" | "exc";
    exemption_reason?: string;
    name_override?: string;
  }>;
  // VIES checker for B2B EU reverse-charge classification. Built once per
  // pipeline run when `config.b2b_reverse_charge === 1` so IxBuilder can
  // decide whether to apply M16/M40 exemptions on EU cross-border orders.
  viesChecker?: (countryCode: string, vatNumber: string) => Promise<boolean | null>;
}

export interface WebhookVerification {
  ok: boolean;
  rawBody: string;
}

export interface SourceAdapter {
  readonly kind: SourceKind;
  verifyWebhook(rawBody: string, signature: string, secret: string): Promise<boolean>;
  externalId(parsedBody: any): string;
  toNormalized(parsedBody: any, ctx: AdapterCtx): Promise<Normalized | null>;
}

export interface NormalizedRefund {
  refundId: string | number;
  itemsIds: Array<string | number>;
  amountToRefund: number;
}

export interface DestinationInvoiceCreateResult {
  invoiceId: string;
}

export interface DestinationCreditResult {
  creditId: string;
}

export interface DestinationAdapter {
  readonly kind: DestinationKind;
  createDraft(normalized: Normalized, ctx: AdapterCtx): Promise<DestinationInvoiceCreateResult>;
  finalize(invoiceId: string, ctx: AdapterCtx): Promise<void>;
  issueCredit(invoiceId: string, refund: NormalizedRefund, normalized: Normalized, ctx: AdapterCtx): Promise<DestinationCreditResult>;
  emailDocument?(invoiceId: string, ctx: AdapterCtx): Promise<void>;
  findByReference?(reference: string, ctx: AdapterCtx): Promise<{ id: string } | null>;
}
