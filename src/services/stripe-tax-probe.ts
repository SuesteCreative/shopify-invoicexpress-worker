import type { Env } from "../env";
import { stripeFetch } from "./stripe";
import { resolveStripeAuth } from "./stripe-auth";

/**
 * Does what this connection DECLARES match what its Stripe account SHOWS?
 *
 * Not a "does this merchant charge VAT" alarm. A large part of this fleet is
 * legitimately exempt — art.53, M01/M05/M10/M40 — and a 0% document carrying
 * the right exemption code is the correct output for them. Absence of tax is a
 * normal state and is never reported as a fault.
 *
 * What IS worth knowing is the mismatch. `stripe_tax_from_source` is born 0,
 * and with it at 0 a `payment_intent.succeeded` maps to a single 0% line: only
 * the Checkout Session carries Stripe Tax's numbers, and nothing looks it up
 * unless the flag says so. So a merchant who collects 23% through Stripe was
 * invoiced at 0%, under an exemption nobody chose. That is the case this reads
 * the account to catch, and it is the only case where the probe changes
 * anything by itself.
 *
 * `read_only` is the whole OAuth scope, so everything here is a GET.
 */

export type TaxProbeVerdict =
  /** Payments carry tax. The flag is turned on, from evidence. */
  | "taxed"
  /** No tax at source, but the connection states a rate to apply. Consistent. */
  | "rule_rate"
  /** No tax at source, and the connection states an exemption. Consistent. */
  | "exempt"
  /** No tax, no rate, no exemption code: nobody has said what this should be. */
  | "undeclared_zero"
  /** A brand-new account with nothing to look at yet. */
  | "no_data"
  | "error";

export interface TaxProbeResult {
  verdict: TaxProbeVerdict;
  /** How many taxed objects were seen, for the operator reading the panel. */
  taxedSeen: number;
  sampled: number;
  flagTurnedOn: boolean;
  message?: string;
}

/** One page each. Two GETs is enough to answer "does this account ever charge tax". */
const SAMPLE = 20;

export function taxProbeEnabled(env: Env): boolean {
  return (env as any).STRIPE_TAX_PROBE_ENABLED === "1";
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function listTaxed(path: string, apiKey: string, account: string | null | undefined): Promise<{ sampled: number; taxed: number }> {
  const query = new URLSearchParams({ limit: String(SAMPLE) });
  const res = await stripeFetch(path, apiKey, { stripeAccount: account, query });
  if (!res.ok) throw new Error(`Stripe ${path} ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const body: any = await res.json();
  const data: any[] = body?.data ?? [];
  let taxed = 0;
  for (const o of data) {
    // Checkout Session: total_details.amount_tax. Invoice: `tax` on older API
    // versions, `total_taxes[]` on 2025+. Any of them positive is proof enough.
    const sessionTax = num(o?.total_details?.amount_tax);
    const invoiceTax = num(o?.tax) || (Array.isArray(o?.total_taxes)
      ? o.total_taxes.reduce((s: number, t: any) => s + num(t?.amount), 0)
      : 0);
    if (sessionTax > 0 || invoiceTax > 0) taxed++;
  }
  return { sampled: data.length, taxed };
}

/**
 * What the connection says about itself.
 *
 * The honest caveat: the Moloni wizard defaults `exemption_reason` to "M01",
 * and by value a default is indistinguishable from a deliberate choice. So a
 * present code is read as a declaration, which means some `exempt` verdicts are
 * really "nobody chose". That errs towards silence, and silence is the safe
 * direction here: nothing is blocked, no document changes, and the case surfaces
 * anyway the first time the merchant checks their five run-in drafts. The
 * InvoiceXpress side has no such default — the field is simply empty, and
 * InvoiceXpress then stamps M99 on its own, which is the failure worth naming.
 */
function declaredRegime(destinationConfig: Record<string, any> | null | undefined): "rate" | "exempt" | "none" {
  const cfg = destinationConfig ?? {};
  if (num(cfg.force_tax_rate) > 0 || num(cfg.default_vat_rate) > 0) return "rate";
  const code = String(cfg.exemption_reason ?? cfg.ix_exemption_reason ?? "").trim();
  return code ? "exempt" : "none";
}

export async function probeConnectionTax(
  env: Env,
  conn: {
    id: string;
    user_id: string;
    destination_kind: string;
    source_config_json: string | null;
    destination_config_json: string | null;
  },
): Promise<TaxProbeResult> {
  const parse = (s: string | null) => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };
  const sourceConfig = parse(conn.source_config_json);
  const destinationConfig = parse(conn.destination_config_json);

  let result: TaxProbeResult;
  try {
    const auth = resolveStripeAuth(env as any, sourceConfig);
    if (!auth) throw new Error("sem credencial Stripe utilizável nesta ligação");

    const [sessions, invoices] = await Promise.all([
      listTaxed("checkout/sessions", auth.apiKey, auth.connectAccount),
      listTaxed("invoices", auth.apiKey, auth.connectAccount),
    ]);
    const taxedSeen = sessions.taxed + invoices.taxed;
    const sampled = sessions.sampled + invoices.sampled;

    if (taxedSeen > 0) {
      result = { verdict: "taxed", taxedSeen, sampled, flagTurnedOn: true };
    } else if (sampled === 0) {
      result = { verdict: "no_data", taxedSeen: 0, sampled, flagTurnedOn: false };
    } else {
      const declared = declaredRegime(destinationConfig);
      result = {
        verdict: declared === "rate" ? "rule_rate" : declared === "exempt" ? "exempt" : "undeclared_zero",
        taxedSeen: 0, sampled, flagTurnedOn: false,
      };
    }
  } catch (e: any) {
    result = { verdict: "error", taxedSeen: 0, sampled: 0, flagTurnedOn: false, message: String(e?.message ?? e) };
  }

  const now = new Date().toISOString();
  // The flag goes in as a JSON boolean and nothing else: `projectConnectionBehaviour`
  // only projects booleans off the blob, so writing 1 here would be stored,
  // shown as set, and silently never reach the adapter.
  const patch = result.flagTurnedOn ? JSON.stringify({ stripe_tax_from_source: true }) : null;
  await env.DB.prepare(
    patch
      ? `UPDATE connections SET tax_probe_at = ?, tax_probe_verdict = ?, updated_at = ?,
             destination_config_json = json_patch(COALESCE(destination_config_json, '{}'), ?)
          WHERE id = ?`
      : `UPDATE connections SET tax_probe_at = ?, tax_probe_verdict = ?, updated_at = ? WHERE id = ?`
  ).bind(...(patch ? [now, result.verdict, now, patch, conn.id] : [now, result.verdict, now, conn.id])).run();

  // The one verdict that wants a human, and it wants OURS: "charges nothing,
  // declares nothing" is a question for the onboarding call, where the answer is
  // either an exemption code or a force_tax_rate. No incident and no merchant
  // email — it is not a fault, and the merchant cannot act on it. It is stored
  // on the row for the panel, and said out loud here for the sweep's log.
  if (result.verdict === "undeclared_zero") {
    console.warn(`[TaxProbe] ${conn.user_id} (${conn.destination_kind}): sem imposto na origem e sem regime declarado — documentos sairão a 0% com a isenção que o destino escolher`);
  }

  return result;
}

/**
 * Every active Connect connection that has not yet been shown to charge tax.
 *
 * Re-read daily rather than once, because a merchant who switches Stripe Tax on
 * a week after onboarding would otherwise keep being invoiced at 0% until
 * somebody noticed by hand. Once the flag is on there is nothing left to learn,
 * so those rows drop out of the query.
 */
export async function runStripeTaxProbeSweep(env: Env): Promise<{ checked: number; taxed: number; verdicts: Record<string, number> }> {
  const rows: any[] = ((await env.DB.prepare(
    `SELECT id, user_id, destination_kind, source_config_json, destination_config_json
       FROM connections
      WHERE source_kind = 'stripe_connect' AND status = 'active'
        AND COALESCE(json_extract(destination_config_json, '$.stripe_tax_from_source'), 0) NOT IN (1, 'true')`
  ).all()).results ?? []) as any[];

  const verdicts: Record<string, number> = {};
  let taxed = 0;
  for (const row of rows) {
    const r = await probeConnectionTax(env, row);
    verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
    if (r.flagTurnedOn) taxed++;
  }
  return { checked: rows.length, taxed, verdicts };
}
