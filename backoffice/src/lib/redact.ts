/**
 * What of a connection's config may be shown to the operator's browser.
 *
 * `destination_config_json` mixes two kinds of value: fiscal settings, which are
 * the entire point of a rules console, and credentials, which must never leave
 * the server. Redaction is therefore an ALLOWLIST — a denylist of secret-looking
 * names is one new key away from leaking, and the key that leaks is always the
 * one nobody thought to pattern-match.
 *
 * Anything not named here is reported only as present or absent.
 */

/** Fiscal / behavioural settings — safe to read, and the ones worth editing. */
export const FISCAL_CONFIG_KEYS = [
  // Cross-destination behaviour
  "vat_included",
  "auto_finalize",
  "send_email",
  "exemption_reason",
  "default_vat_rate",
  "custom_invoice_note",
  // Stripe→InvoiceXpress fiscal rework (migration 0037). Readable and editable
  // on the connection blob as well as the legacy row, because a Stripe→IX
  // client has no `shopify_domain` and the console hides the legacy section for
  // exactly those clients — without these names here, the switches would be
  // reachable only by hand-written SQL.
  "ix_derive_exemption",
  "ix_adapter_safety_nets",
  "stripe_tax_from_source",
  "tag_route_by_country",
  "ix_require_series",
  "stripe_metadata_map",
  "ix_multicurrency",
  "stripe_routing_hints",
  // Tax behaviour. `projectConnectionBehaviour` isolates these per connection
  // (CONNECTION_FISCAL_RATES / _TOGGLES) — and until now nothing could write
  // them there. The console offered the fields, wrote them to the legacy row,
  // and the worker stopped reading that row for any non-Shopify source: so
  // turning OSS on for a Stripe connection changed nothing and said nothing.
  "oss_enabled",
  "b2b_reverse_charge",
  "force_tax_rate",
  "force_shipping_tax_rate",
  // Decide the rate from the buyer's country instead of taking it from the
  // source. Off unless stated, which is what keeps the legacy Shopify fleet
  // — with `oss_enabled` defaulted to 1 since 0002 — out of it entirely.
  "oss_engine",
  "oss_export_exemption_code",
  // Portugal's regional rates, which follow the CUSTOMER's domicile. Its own
  // key because the merchants who need it — B2B reverse charge — are exactly
  // the ones who must never have the OSS engine.
  "pt_regional_rates",
  // "I supply services under art. 6.º n.º 6 / art. 196.º". Its own key rather
  // than the legacy `b2b_reverse_charge`, which on the adapter pipeline builds
  // a VIES checker and never consults it — reusing it would turn a no-op into
  // a money-mover for everyone who has it, on the day of the merge.
  "b2b_reverse_charge_pipeline",
  // The fiscal identity of the documents this connection issues.
  //
  // `exemption_reason` above is Moloni's name for the same idea, and it is NOT
  // interchangeable: the isolation guard accepts either spelling as "stated",
  // but the identity override only copies from `ix_exemption_reason`. Setting
  // only the Moloni spelling on an IX connection therefore neither sets a code
  // nor clears one — the document silently inherits the account's.
  "ix_sequence_name",
  "ix_document_type",
  "ix_exemption_reason",
  "ix_b2b_exemption_reason",
  // Moloni
  "moloni_company_id",
  "moloni_company_name",
  "moloni_document_set_id",
  "moloni_document_set_name",
  "moloni_document_type",
  "moloni_environment",
  "moloni_partial_invoicing",
  "moloni_default_tax_id",
  "moloni_category_id",
  "moloni_maturity_date_id",
  "moloni_payment_method",
  // Partial / instalment invoicing. Offered by the console and read by the
  // worker (lodgify-amounts.ts, moloni-destination.ts) but missing here, so
  // saving any of the three answered "Not editable".
  "moloni_partial_mode",
  "moloni_receipt_document_set_name",
  "moloni_receipt_series_map",
  // Vendus
  "vendus_register_id",
  "vendus_series_id",
  "vendus_environment",
  // Lodgify-specific behaviour, stored on the destination blob
  "lodgify_extras_vat_rate",
  "lodgify_ota_invoice_on",
] as const;

export type FiscalConfigKey = typeof FISCAL_CONFIG_KEYS[number];

const FISCAL_KEY_SET = new Set<string>(FISCAL_CONFIG_KEYS);

/**
 * Non-fiscal keys worth surfacing as "is it set?" — the operator needs to see
 * that a connection HAS credentials without ever receiving them.
 */
const PRESENCE_ONLY_KEYS = [
  "moloni_client_id", "moloni_client_secret", "moloni_username", "moloni_password",
  "vendus_api_key", "restricted_key", "webhook_secret", "hmac_secret", "api_key",
] as const;

/**
 * The columns of `connections` a merchant's browser may receive.
 *
 * `SELECT *` is not a projection, it is whatever the last migration added — and
 * on this table that is a Moloni refresh token, a Stripe restricted key, a
 * Lodgify API key, a webhook secret, the live OAuth nonce and the run-in token
 * that answers a PUBLIC route. /api/connections handed all of it to the browser
 * of anyone signed in to the account, read-only invited members included.
 *
 * An allowlist for the same reason the config redaction above is one: the column
 * added by the next migration must leak nothing until somebody names it here.
 * Nothing on this list is a credential, and nothing on it needs to be — what the
 * UI actually wants to know about credentials is whether they are there, which
 * is what `destination_ready` answers.
 */
export const CONNECTION_PUBLIC_COLUMNS = [
  "id",
  "user_id",
  "source_kind",
  "destination_kind",
  "status",
  "admin_label",
  "invoice_cutoff",
  "created_at",
  "updated_at",
  // Onboarding bookkeeping (0047/0050): when the Moloni token was last renewed,
  // the Stripe Tax probe's verdict, and the run-in answer. Timestamps and
  // verdicts — never the tokens they are about.
  "last_token_refresh_at",
  "tax_probe_at",
  "tax_probe_verdict",
  "runin_asked_at",
  "runin_reminded_at",
  "runin_answer",
] as const;

/** The same list, ready to drop into a SELECT. */
export const CONNECTION_PUBLIC_SELECT = CONNECTION_PUBLIC_COLUMNS.join(", ");

/**
 * The legacy `integrations` row is the other shape credentials live in: not a
 * JSON blob but columns, one row per account, and it is the row /api/integrations
 * used to spread whole into a browser — the Shopify Admin token, the webhook
 * secret, the InvoiceXpress key EVERY connection files with, and the OAuth app
 * secret and nonce from migration 0053.
 *
 * A pattern rather than a list of names, because the column is the leak: the
 * forty fiscal settings on this row are what the wizards render, so an allowlist
 * of names would have to be maintained against every migration and would break a
 * wizard quietly each time somebody forgot. Every credential this table has ever
 * held is named after what it is, so name-shaped is the check that also catches
 * the one added next year.
 */
const INTEGRATION_SECRET_COLUMN = /(^|_)(token|secret|api_key|password|client_id|oauth_state)($|_)/;

/**
 * The row as a browser may see it: every credential column replaced by
 * `has_<column>`, which is all a wizard ever needed — whether a credential is
 * set, never what it is.
 *
 * Paired with "blank means unchanged" in the POST: a form that renders with the
 * field empty must not be able to erase what is stored.
 */
export function stripIntegrationSecrets(
  row: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row ?? {})) {
    if (INTEGRATION_SECRET_COLUMN.test(column)) {
      safe[`has_${column}`] = value != null && String(value).trim() !== "";
      continue;
    }
    safe[column] = value;
  }
  return safe;
}

export interface RedactedConfig {
  /** Fiscal settings, verbatim. */
  fiscal: Record<string, unknown>;
  /** Credential-shaped keys, as booleans only. */
  present: Record<string, boolean>;
}

export function redactConnectionConfig(raw: unknown): RedactedConfig {
  const cfg = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const fiscal: Record<string, unknown> = {};
  const present: Record<string, boolean> = {};

  for (const [key, value] of Object.entries(cfg)) {
    if (FISCAL_KEY_SET.has(key)) {
      fiscal[key] = value;
      continue;
    }
    // Everything else — named credential or not — reduces to a boolean. A key
    // this file has never heard of is treated as a secret, not as data.
    present[key] = value != null && value !== "";
  }

  // Credentials the connection has never held still read as absent rather than
  // missing from the payload, so the UI can render a consistent checklist.
  for (const key of PRESENCE_ONLY_KEYS) {
    if (!(key in present)) present[key] = false;
  }

  return { fiscal, present };
}

/** Parse + redact in one step, tolerating the malformed JSON D1 may hold. */
export function redactConfigJson(json: string | null | undefined): RedactedConfig {
  if (!json) return redactConnectionConfig({});
  try {
    return redactConnectionConfig(JSON.parse(json));
  } catch {
    return redactConnectionConfig({});
  }
}
