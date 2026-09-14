import type { Env } from "../env";

/**
 * Who an account IS, for anything a human reads.
 *
 * Rioko keys everything on `users.id`, a Clerk id that identifies nothing to a
 * person. Every surface that names an account therefore resolves a LABEL, and
 * until now each one resolved it differently: the sweep used
 * `admin_label → company_name → name`, the quota alert used `company_name → name`,
 * and the incident emails used `name` alone. That last one is why the alert in
 * the inbox says "User".
 *
 * "User" is not a name. The Clerk webhook writes it whenever a signup arrives
 * with no first name, no last name and no username
 * (`backoffice/src/app/api/webhooks/clerk/route.ts`), so it is a placeholder
 * sitting in a column that every reader treats as an answer. It stays in the
 * row — deleting it would only invite the webhook to write it again — and is
 * instead refused here, once, by everything that reads.
 *
 * The account NUMBER (`client_code`, `RIO-1A2B3C`, migration 0058) rides along
 * as a complement, never as a replacement: a person reads the company name
 * first and quotes the number second.
 */

/** Values that occupy the name column without naming anybody. Compared
 *  case-insensitively after trimming. */
const PLACEHOLDER_NAMES = new Set(["user", "utilizador", "unknown", "n/a", "-"]);

export interface AccountLabelFields {
  id?: string | null;
  name?: string | null;
  company_name?: string | null;
  admin_label?: string | null;
  email?: string | null;
  client_code?: string | null;
}

export interface AccountIdentity {
  /** What the account is called: "Bestisafil". Never a Clerk id, never "User". */
  label: string;
  /** `RIO-D97EC7`, when the account has one. */
  code?: string;
}

const clean = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length > 0 ? s : undefined;
};

/** A personal name, or nothing — the placeholder never counts as one. */
export function realName(v: unknown): string | undefined {
  const s = clean(v);
  return s && !PLACEHOLDER_NAMES.has(s.toLowerCase()) ? s : undefined;
}

/**
 * What the account calls itself, or nothing at all: `admin_label` (what an
 * admin pinned in superadmin) → `company_name` → the personal name. Nothing
 * here is a stand-in — an account with no registered label returns undefined,
 * which is what lets a caller print something better than an email address
 * (the shop domain, say) instead.
 */
export function accountName(u: AccountLabelFields | null | undefined): string | undefined {
  if (!u) return undefined;
  return clean(u.admin_label) ?? clean(u.company_name) ?? realName(u.name);
}

/** `accountName`, and when there is none, the email, the caller's fallback, the
 *  raw id — in that order, so something always comes back. */
export function accountLabel(u: AccountLabelFields | null | undefined, fallback?: string): string {
  if (!u) return fallback ?? "";
  return accountName(u) ?? clean(u.email) ?? fallback ?? clean(u.id) ?? "";
}

/** The same precedence as one SQL expression. Callers alias it themselves. */
export const ACCOUNT_LABEL_SQL = (alias = "u") =>
  `COALESCE(NULLIF(TRIM(${alias}.admin_label), ''), NULLIF(TRIM(${alias}.company_name), ''), ${REAL_NAME_SQL(alias)}, ${alias}.email, ${alias}.id)`;

/** `users.name` unless it is the placeholder, for queries that want the person
 *  (a greeting) rather than the account. */
export function REAL_NAME_SQL(alias = "u"): string {
  const list = [...PLACEHOLDER_NAMES].map((p) => `'${p}'`).join(",");
  return `CASE WHEN LOWER(TRIM(COALESCE(${alias}.name, ''))) IN (${list}) THEN NULL ELSE NULLIF(TRIM(${alias}.name), '') END`;
}

/** "Bestisafil · RIO-D97EC7" — name first, number as a complement. */
export function accountIdentityLine(id: AccountIdentity | undefined | null): string | undefined {
  if (!id?.label) return id?.code ?? undefined;
  return id.code ? `${id.label} · ${id.code}` : id.label;
}

/** One account, for the email about to be sent. Never throws: a failed lookup
 *  renders an email without the line rather than no email at all. */
export async function resolveAccountIdentity(
  env: Env,
  userId?: string | null,
): Promise<AccountIdentity | undefined> {
  if (!userId) return undefined;
  try {
    const row: any = await env.DB.prepare(
      "SELECT id, name, company_name, admin_label, email, client_code FROM users WHERE id = ?",
    ).bind(userId).first();
    if (!row) return undefined;
    const label = accountLabel(row);
    const code = clean(row.client_code);
    return label || code ? { label, code } : undefined;
  } catch {
    return undefined;
  }
}
