import type { Env } from "../env";
import { reportIncident } from "./incidents";
import { connectionLabelOf } from "./connection-context";

/**
 * "Is every ACTIVE connection actually able to issue a document?"
 *
 * Every other alarm in this system is triggered by a failure: a document the
 * destination rejected, a token that expired, a queue that ran out of retries.
 * None of them fire for the failure that costs the most, which is a connection
 * that was never finished. There is no document to reject, because nothing is
 * ever built; the merchant's dashboard says active, their subscription is paid,
 * and their payments quietly go uninvoiced until somebody counts.
 *
 * Measured on 2026-09-12: three live accounts in that state. One had issued
 * nothing since the day it onboarded; one had been issuing for months and
 * stopped the moment an admin action removed the row its credentials lived on;
 * one was one booking away from the same.
 *
 * So this asks the question directly, once a night, of every active connection:
 * are the destination's credentials there? It is deliberately a check of
 * CONFIGURATION and not of connectivity — no call leaves the worker — because
 * the failure it exists to catch is structural, and a check that costs nothing
 * is a check that can run for the whole fleet every single night.
 */

export interface ConnectionHealthResult {
  checked: number;
  unconfigured: number;
  reported: number;
  /** `${user_id} ${source}→${destination}: ${reason}` — for the cron log. */
  findings: string[];
}

/** Human name of the destination, for a merchant-facing sentence. */
const DESTINATION_NAMES: Record<string, string> = {
  invoicexpress: "InvoiceXpress",
  moloni: "Moloni",
  vendus: "Vendus",
};

function parse(json: unknown): Record<string, any> {
  try { return json ? JSON.parse(String(json)) : {}; } catch { return {}; }
}

const filled = (v: unknown) => !!String(v ?? "").trim();

/**
 * What is missing, in one sentence, or null when the connection is complete.
 *
 * The three destinations keep their credentials in two different places, which
 * is exactly why this kept being missed: InvoiceXpress authenticates with the
 * account-wide `integrations` row — shared by Shopify, Stripe, Lodgify and
 * EuPago alike — while Moloni and Vendus keep theirs on the connection itself.
 */
export function missingDestinationCredential(
  destinationKind: string,
  destinationConfig: Record<string, any>,
  legacyRow: Record<string, any> | null,
): string | null {
  if (destinationKind === "invoicexpress") {
    if (filled(legacyRow?.ix_account_name) && filled(legacyRow?.ix_api_key)) return null;
    if (!legacyRow) return "Não há credenciais de InvoiceXpress guardadas nesta conta (nome da conta e chave API).";
    if (!filled(legacyRow.ix_account_name) && !filled(legacyRow.ix_api_key)) {
      return "O nome da conta e a chave API do InvoiceXpress estão por preencher.";
    }
    return filled(legacyRow.ix_account_name)
      ? "Falta a chave API do InvoiceXpress."
      : "Falta o nome da conta InvoiceXpress.";
  }

  if (destinationKind === "moloni") {
    const oauth = destinationConfig.moloni_auth_mode === "oauth" || filled(destinationConfig.moloni_refresh_token);
    const legacyPair = filled(destinationConfig.moloni_client_id) && filled(destinationConfig.moloni_username);
    return oauth || legacyPair ? null : "A autorização do Moloni não está guardada nesta ligação.";
  }

  if (destinationKind === "vendus") {
    return filled(destinationConfig.vendus_api_key) ? null : "Falta a chave API do Vendus.";
  }

  // A destination this does not know about is not something it can judge, and
  // inventing an alarm for one would train everybody to ignore the alarm.
  return null;
}

/**
 * `dryRun` finds and reports nothing.
 *
 * The first real run of this emails every affected merchant directly, which is
 * right on any ordinary night and wrong on the night it ships: the backlog it
 * finds on day one is a backlog we already know about and are already talking
 * to those merchants about. So the fleet can be surveyed first, and told
 * afterwards.
 */
export async function runConnectionHealthCheck(
  env: Env,
  opts: { dryRun?: boolean } = {},
): Promise<ConnectionHealthResult> {
  const result: ConnectionHealthResult = { checked: 0, unconfigured: 0, reported: 0, findings: [] };

  const rows: any[] = ((await env.DB.prepare(
    `SELECT c.user_id, c.id AS connection_id, c.source_kind, c.destination_kind,
            c.destination_config_json,
            i.ix_account_name, i.ix_api_key
       FROM connections c
       LEFT JOIN integrations i ON i.user_id = c.user_id
      WHERE c.status = 'active'
      ORDER BY c.created_at`
  ).all()).results ?? []) as any[];

  for (const row of rows) {
    result.checked++;
    const destinationKind = String(row.destination_kind ?? "");
    // `i.*` come back as NULL both when the row is absent and when its columns
    // are empty. The two are told apart here so the sentence can be honest: one
    // is "you never saved them", the other "they were cleared".
    const legacyRow = row.ix_account_name === null && row.ix_api_key === null
      ? null
      : { ix_account_name: row.ix_account_name, ix_api_key: row.ix_api_key };

    const missing = missingDestinationCredential(destinationKind, parse(row.destination_config_json), legacyRow);
    if (!missing) continue;

    result.unconfigured++;
    const label = connectionLabelOf(row.source_kind, destinationKind);
    result.findings.push(`${row.user_id} ${label}: ${missing}`);
    if (opts.dryRun) continue;

    try {
      await reportIncident(env, {
        user_id: String(row.user_id),
        connection_id: String(row.connection_id),
        severity: "error",
        kind: "connection_unconfigured",
        // Daily, not hourly: this is a standing condition, not an event. One
        // email a day until it is fixed, and the bucket reopens each morning so
        // a week of silence is a week of reminders rather than one lost ping.
        bucket: "daily",
        summary: `Ligação ${label} está activa mas não consegue emitir: ${missing}`,
        connection_label: label,
        detail: {
          destination: DESTINATION_NAMES[destinationKind] ?? destinationKind,
          missing,
          connectionId: row.connection_id,
        },
      });
      result.reported++;
    } catch (e: any) {
      console.error(`[ConnHealth] report failed for ${row.user_id}: ${e?.message ?? e}`);
    }
  }

  return result;
}
