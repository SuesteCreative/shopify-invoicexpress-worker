/**
 * What an account may declare about how its documents are produced.
 *
 * A rule is an INTENT with named alternatives, not a switch. "Where does the
 * buyer's address come from" has more than two answers and will have more again;
 * a boolean can only ever say yes to whichever answer somebody needed first,
 * which is how twenty-four behaviour flags became fourteen one-merchant
 * corrections — eight of them enabled on exactly one account.
 *
 * The intent is also the unit that survives contact with the pipeline. Bestisafil
 * needed one thing — their buyer's address comes from the payment — and it took
 * two flags read at three places, because a boolean names a mechanism and an
 * intent names a decision. Generic code can implement a decision everywhere it
 * applies; it cannot do that for a mechanism.
 *
 * ONE declaration. The worker's read site, the validation, and (when it lands)
 * the console's form and labels all derive from this object. Adding a rule means
 * editing this file and the code that reads it, and nothing else — not
 * `IRequestConfig`, not `synthLegacyConfig`, not `CONNECTION_FISCAL_FLAGS`, not
 * `FISCAL_CONFIG_KEYS`, not `DANGEROUS_FIELDS`, not the console's field list.
 * That list is exactly what this replaces.
 *
 * ZERO IMPORTS, and a test that keeps it that way. This module is meant to be
 * read by the Next backoffice as well as the Worker, and one import of
 * `../storage` would drag the Worker's world into an edge bundle. It is why the
 * kinds below are plain strings rather than the `SourceKind` union.
 */

/** One alternative a rule offers, and what choosing it does. */
export interface RuleDef {
  /** Stored in `account_rules.rule_id`. snake_case, and never renamed once written. */
  readonly id: string;
  /**
   * What the code does when the account declared nothing — today's behaviour,
   * spelled as data.
   *
   * This constant is the whole "absent rules change nothing" guarantee. Read
   * sites compare against a NON-default option, so with no row the comparison is
   * false and the expression is the one that ran before the rule existed. There
   * is no second code path to drift.
   */
  readonly default: string;
  /** Every alternative, in the order an operator should see them. */
  readonly options: readonly string[];
  /** Operator-facing. Hiperadmin-only and Portuguese, so not run through i18n. */
  readonly label: string;
  /** What each option literally does. Shown under the choice. */
  readonly help: Readonly<Record<string, string>>;
  /** Which pairs may declare it. Empty means any. */
  readonly appliesTo: { readonly sources?: readonly string[]; readonly destinations?: readonly string[] };
  /** true ⇒ the console demands an explicit confirmation, like DANGEROUS_FIELDS. */
  readonly dangerous?: boolean;
}

export const RULES: Readonly<Record<string, RuleDef>> = {
  buyer_address: {
    id: "buyer_address",
    default: "customer_record",
    options: ["customer_record", "payment_then_customer"],
    label: "De onde vem a morada do comprador",
    help: {
      customer_record:
        "Só do registo de cliente da origem. É o que todas as contas fazem.",
      payment_then_customer:
        "Primeiro do pagamento — o que o comprador escreveu ao pagar — e depois do "
        + "registo de cliente. Medido na Bestisafil a 14/09/2026: dos 77 pagamentos "
        + "pagos em Setembro, 77 tinham morada completa no pagamento e 21 no registo.",
    },
    appliesTo: { sources: ["stripe", "stripe_connect"] },
    // Mexe no `country_code`, que a jusante decide se o NIF português é aceite,
    // e escolhe qual das duas moradas do Stripe chega ao documento.
    dangerous: true,
  },
};

/** Every rule at its default: what an account that declared nothing gets. */
export const NO_RULES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.values(RULES).map((r) => [r.id, r.default])),
);

/**
 * The value, if the catalogue recognises it. `null` otherwise.
 *
 * Used on write AND on read: a row put there by hand, or one left behind by a
 * catalogue version that has since dropped an option, must not reach a document
 * as a string nothing handles.
 */
export function parseRuleValue(id: string, raw: unknown): string | null {
  const def = RULES[id];
  if (!def) return null;
  return typeof raw === "string" && def.options.includes(raw) ? raw : null;
}

/** Whether a pair may declare this rule at all. */
export function ruleAppliesTo(id: string, sourceKind: string, destinationKind: string): boolean {
  const def = RULES[id];
  if (!def) return false;
  const { sources, destinations } = def.appliesTo;
  if (sources && !sources.includes(sourceKind)) return false;
  if (destinations && !destinations.includes(destinationKind)) return false;
  return true;
}
