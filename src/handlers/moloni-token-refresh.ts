import type { Env } from "../env";
import { reportIncident } from "../services/incidents";
import {
  createMoloniTokenProvider,
  MoloniReauthRequired,
  REFRESH_RENEW_WINDOW_DAYS,
} from "../services/moloni-oauth";

export interface MoloniRefreshResult {
  ranAt: string;
  checked: number;
  renewed: number;
  failed: number;
  /** Connections whose refresh token is gone; only the merchant can fix these. */
  needsReauth: Array<{ user_id: string; source_kind: string }>;
}

/**
 * Nightly keep-alive for Moloni OAuth connections.
 *
 * A Moloni refresh token lives 14 days and rotates on every use. A shop that
 * invoices daily never needs this — issuing a document already refreshes the
 * pair. It exists for the quiet ones: a seasonal rental, a shop between
 * campaigns, a merchant on holiday. Without it their connection expires in the
 * background and the first sale after the break fails.
 *
 * Renews when the refresh token has less than a week left, so a night that fails
 * has six more to succeed in before anyone is bothered.
 */
export async function refreshMoloniConnections(env: Env): Promise<MoloniRefreshResult> {
  const result: MoloniRefreshResult = {
    ranAt: new Date().toISOString(),
    checked: 0,
    renewed: 0,
    failed: 0,
    needsReauth: [],
  };

  const rows = await env.DB.prepare(
    `SELECT user_id, source_kind, destination_kind, destination_config_json
       FROM connections
      WHERE destination_kind = 'moloni'
        AND status = 'active'
        AND json_extract(destination_config_json, '$.moloni_auth_mode') = 'oauth'`
  ).all();

  const deadline = Date.now() + REFRESH_RENEW_WINDOW_DAYS * 86_400_000;

  for (const row of ((rows.results as any[]) ?? [])) {
    let destinationConfig: Record<string, any>;
    try {
      destinationConfig = JSON.parse(row.destination_config_json ?? "{}");
    } catch {
      continue;
    }

    // Renew on whichever clock runs out first: the access token (an hour) or the
    // refresh token's remaining life (a fortnight). Reading only the second would
    // let a connection sit on an hours-dead access token all day, which is fine
    // for the pipeline (it refreshes on demand) but hides a broken credential
    // until a real sale trips over it.
    const refreshExpiresAt = Date.parse(String(destinationConfig.moloni_refresh_expires_at ?? ""));
    const needsRenewal = !Number.isFinite(refreshExpiresAt) || refreshExpiresAt < deadline;
    if (!needsRenewal) continue;

    result.checked++;

    const provider = createMoloniTokenProvider(env, {
      userId: String(row.user_id),
      source: row.source_kind,
      destination: row.destination_kind,
      destinationConfig,
    });
    if (!provider) {
      // No app credentials at all — a half-finished setup, not a live connection
      // going bad. Left alone rather than reported every single night.
      continue;
    }

    try {
      // Force a rotation rather than accept a still-valid access token: the point
      // of the run is to reset the 14-day clock on the REFRESH token, and a cached
      // access token would return without touching it.
      delete destinationConfig.moloni_token_expires_at;
      await provider.get();
      result.renewed++;
    } catch (e: any) {
      result.failed++;
      const permanent = e instanceof MoloniReauthRequired;
      if (permanent) {
        result.needsReauth.push({ user_id: String(row.user_id), source_kind: String(row.source_kind) });
      }
      try {
        await reportIncident(env, {
          user_id: String(row.user_id),
          severity: permanent ? "critical" : "warning",
          kind: "auth_failure_destination",
          summary: permanent
            ? "A ligação ao Moloni expirou. O cliente tem de autorizar outra vez."
            : `Não foi possível renovar o token do Moloni: ${String(e?.message ?? e).slice(0, 120)}`,
          detail: { message: String(e?.message ?? e), permanent },
          connection_label: `${row.source_kind} → moloni`,
          bucket: "daily",
        });
      } catch (incErr) {
        console.error("[MoloniRefresh] could not report the failure:", incErr);
      }
    }
  }

  return result;
}
