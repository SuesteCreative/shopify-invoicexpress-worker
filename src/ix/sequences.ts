import { ixAccountHost } from "./host";

/**
 * One row of InvoiceXpress's `sequences.json`. The shape that matters is the
 * one nobody read: a "series" is not a single sequence, it is a FAMILY, and it
 * carries a separate numeric id per document type.
 */
export interface IxSequenceRow {
  id: number;
  serie: string;
  current_invoice_sequence_id?: number;
  current_invoice_receipt_sequence_id?: number;
  current_simplified_invoice_sequence_id?: number;
  current_credit_note_sequence_id?: number;
  current_debit_note_sequence_id?: number;
  current_receipt_sequence_id?: number;
}

/** The fields of a connection this module needs to talk to IX directly. */
export interface IxAccountConfig {
  ix_account_name?: string | null;
  ix_api_key?: string | null;
  ix_environment?: string | null;
}

// Sequences cache: accountName → rows. Survives within a Worker isolate,
// flushed on cold start. The sequences list changes rarely so this is safe.
const sequencesCache = new Map<string, IxSequenceRow[]>();

/**
 * The id to send for THIS document type.
 *
 * Measured against the IX sandbox on 2026-09-04. A series named
 * INVOICEXPRESSDEMO answers with `id: 47734` and, inside it,
 * `current_invoice_sequence_id: 47734`, `current_invoice_receipt_sequence_id:
 * 47736`, `current_credit_note_sequence_id: 47739`. The top-level `id` is the
 * INVOICE id — so sending it on an invoice-receipt is rejected outright:
 *
 *   POST /v2/documents type=invoice_receipt sequence_id=47734
 *     → HTTP 400 "A série não corresponde ao tipo de documento"
 *   POST /v2/documents type=invoice_receipt sequence_id=47736
 *     → HTTP 200
 *
 * Which means any connection issuing invoice-receipts into a named series has
 * been failing the create entirely, leaving the sale unbilled — and a merchant
 * filing one series per destination country would have hit it on every sale.
 * Falls back to the top-level id when a type-specific one is absent, which is
 * the previous behaviour and correct for plain invoices.
 */
export function pickSequenceId(row: IxSequenceRow, docType: string): number | null {
  const byType: Record<string, number | undefined> = {
    invoice: row.current_invoice_sequence_id,
    invoice_receipt: row.current_invoice_receipt_sequence_id,
    simplified_invoice: row.current_simplified_invoice_sequence_id,
    credit_note: row.current_credit_note_sequence_id,
    debit_note: row.current_debit_note_sequence_id,
    receipt: row.current_receipt_sequence_id,
  };
  const specific = byType[docType];
  if (typeof specific === "number" && specific > 0) return specific;
  return typeof row.id === "number" && row.id > 0 ? row.id : null;
}

/**
 * Resolve the IX numeric sequence_id for a named series (e.g. "B2B2026"), for
 * the document type being issued.
 *
 * Returns null — meaning "let IX use the account default" — when the name is
 * not found or the sequences list does not answer. Callers that must not fall
 * back silently check `ix_require_series` and refuse instead; see the note
 * there for why a wrong series is worse than an unbilled order.
 *
 * Lives here rather than inside the adapter because both paths need it: the
 * adapter pipeline (Stripe, Lodgify, Moloni-bound Shopify) and the legacy
 * Shopify→IX handlers.
 */
export async function resolveIxSequenceId(
  config: IxAccountConfig,
  seriesName: string,
  docType: string = "invoice",
): Promise<number | null> {
  const account = config.ix_account_name;
  const apiKey = config.ix_api_key;
  if (!account || !apiKey) return null;

  const cacheKey = `${account}:${config.ix_environment ?? "production"}`;
  let sequences = sequencesCache.get(cacheKey);

  if (!sequences) {
    try {
      const res = await fetch(
        `${ixAccountHost(account, config.ix_environment)}/sequences.json?api_key=${encodeURIComponent(apiKey)}`,
      );
      if (!res.ok) return null;
      const data = await res.json() as { sequences?: IxSequenceRow[] };
      sequences = data.sequences ?? [];
      // Only cache a non-empty result. An empty list on first fetch (transient
      // network hiccup) must not freeze future lookups for the isolate lifetime.
      if (sequences.length > 0) sequencesCache.set(cacheKey, sequences);
    } catch {
      return null;
    }
  }

  const target = seriesName.trim().toUpperCase();
  const match = sequences.find(s => String(s.serie ?? "").trim().toUpperCase() === target);
  return match ? pickSequenceId(match, docType) : null;
}
