/**
 * The document series an InvoiceXpress account actually has.
 *
 * Read in two places — the picker that offers them, and the rule form that has
 * to refuse a name the account does not know — so the credential handling and
 * the sandbox-vs-production host live here once. Credentials are used and never
 * returned or logged.
 *
 * A series is a FAMILY, not a number: the row's top-level `id` is the invoice
 * sequence, and each document type has its own id inside it. Sending the wrong
 * one is refused by IX outright ("A série não corresponde ao tipo de
 * documento"), which is why the per-type ids are surfaced here.
 */
export interface IxSequence {
  id: number;
  serie: string;
  default_sequence?: number;
  current_invoice_sequence_id?: number;
  current_invoice_receipt_sequence_id?: number;
  current_simplified_invoice_sequence_id?: number;
  current_credit_note_sequence_id?: number;
  current_debit_note_sequence_id?: number;
}

/**
 * `null` means "could not tell" — no credentials stored, or InvoiceXpress did
 * not answer. That is deliberately different from `[]` ("the account has no
 * series"), because a caller validating a name must not reject one on the
 * strength of a failed lookup.
 */
export async function listIxSequences(
  db: any,
  userId: string,
  sourceKind?: string,
): Promise<IxSequence[] | null> {
  // The connection's own credentials first, the account's legacy row as the
  // fallback: the order the worker and `missingDestinationCredentials` already
  // apply. Reading the legacy row alone answered `null` for every account
  // without a Shopify pipe, and `null` here is indistinguishable from "the
  // account has no series" — so the picker went quietly empty and the rule
  // form's series guard skipped itself, on exactly the accounts (WHM, per
  // country) where typing the wrong series costs the most.
  const conn: any = await db
    .prepare(
      `SELECT json_extract(destination_config_json, '$.ix_account_name') AS ix_account_name,
              json_extract(destination_config_json, '$.ix_api_key')      AS ix_api_key,
              json_extract(destination_config_json, '$.ix_environment')  AS ix_environment
         FROM connections
        WHERE user_id = ? AND destination_kind = 'invoicexpress'
          AND json_extract(destination_config_json, '$.ix_account_name') IS NOT NULL
          AND trim(json_extract(destination_config_json, '$.ix_api_key')) <> ''
        ORDER BY (source_kind = ?) DESC, updated_at DESC
        LIMIT 1`
    )
    .bind(userId, sourceKind ?? "")
    .first();

  const integration: any = conn ?? await db
    .prepare("SELECT ix_account_name, ix_api_key, ix_environment FROM integrations WHERE user_id = ?")
    .bind(userId)
    .first();

  const account = integration?.ix_account_name;
  const apiKey = integration?.ix_api_key;
  if (!account || !apiKey) return null;

  // `{account}.invoicexpress.com` has no DNS record at all — the host is
  // `{account}.app.invoicexpress.com`. Measured 2026-09-08; the bare form is
  // what made the worker's own sequence lookup fail silently in production.
  const suffix = integration.ix_environment === "production"
    ? ".app.invoicexpress.com"
    : ".macewindu.invoicexpress.com";

  try {
    const res = await fetch(`https://${account}${suffix}/sequences.json?api_key=${encodeURIComponent(apiKey)}`, {
      headers: { "Accept": "application/json" },
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    return Array.isArray(data?.sequences) ? data.sequences as IxSequence[] : [];
  } catch {
    return null;
  }
}

/** Case-insensitive lookup, matching how the worker resolves a series name. */
export function findSequenceByName(sequences: IxSequence[], name: string): IxSequence | undefined {
  const target = name.trim().toUpperCase();
  return sequences.find(s => String(s.serie ?? "").trim().toUpperCase() === target);
}

/** The id to send for a document type, or null when the series has none. */
export function sequenceIdForDocType(seq: IxSequence, docType: string): number | null {
  const byType: Record<string, number | undefined> = {
    invoice: seq.current_invoice_sequence_id,
    invoice_receipt: seq.current_invoice_receipt_sequence_id,
    simplified_invoice: seq.current_simplified_invoice_sequence_id,
    credit_note: seq.current_credit_note_sequence_id,
    debit_note: seq.current_debit_note_sequence_id,
  };
  const specific = byType[docType];
  if (typeof specific === "number" && specific > 0) return specific;
  return typeof seq.id === "number" && seq.id > 0 ? seq.id : null;
}
