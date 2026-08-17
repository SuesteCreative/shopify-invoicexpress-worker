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
