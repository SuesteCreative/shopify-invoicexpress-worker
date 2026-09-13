import type { Env } from "../env";
import { AppStorage } from "../storage";
import { sendEmail } from "./email";

// ─────────────────────────────────────────────────────────────────────────────
// Who is Rioko deliberately NOT invoicing, and how loudly.
//
// WHY: the subscription gate is correct and it is silent. It runs on the live
// path (orders-created, orders-paid, generic-pipeline, lodgify-poll) AND on the
// nightly sweep, so a merchant whose trial lapses goes dark on both at once.
// Each refused order raises one `subscription_inactive` incident, which is the
// right record and the wrong shape: nobody reads a per-order table, and the
// number that matters is the one nobody computes — how many merchants are
// selling into a closed gate, and for how long.
//
// This is how it looked on 2026-09-13, found only because someone went looking:
// five merchants whose early bird ended on 31 August, still taking orders,
// eleven to seventeen days of silence each, and one cancelled account at
// 17 620,54 € of unbilled sales. Every one of those was "working as designed".
//
// So: one roll-up a day, on the ops cron that already runs, to the address that
// already gets the sweep mail. Deliberately NOT flag-gated. The incident digest
// beside it has been switched off for months and that is exactly how the
// incidents table filled with 180 open buckets nobody saw. A report that only
// speaks when something is wrong does not need a flag to stay quiet.
// ─────────────────────────────────────────────────────────────────────────────

export interface SuppressedMerchant {
  user_id: string;
  displayName: string;
  connectionKey: string;
  /** Why the gate refuses: 'trial_expired' | 'canceled' | 'unpaid' | 'no_subscription' | … */
  reason: string;
  status: string | null;
  trialEnd: string | null;
  /** Refusals recorded in the window. One per order the gate turned away. */
  refusals: number;
  /** When the gate first turned an order away, as far back as the incidents go. */
  since: string | null;
  /** Days since this merchant last had a document issued. null = never. */
  daysSilent: number | null;
}

export interface SuppressionDigestResult {
  ranAt: string;
  merchants: SuppressedMerchant[];
  totalRefusals: number;
  emailed: boolean;
}

/**
 * Mirrors rowAllows() in subscription-gate.ts. Kept as a separate reader rather
 * than imported because the gate answers "may this one order through?" and this
 * answers "who is standing outside?" — the same rule, two directions. If the
 * rule moves, both move: the test pins them to the same cases.
 */
export function subscriptionBlocks(
  sub: { status?: string | null; trial_end?: string | null; early_bird?: number | null; has_sub?: number | null } | null,
  now: Date,
): string | null {
  if (!sub) return "no_subscription";
  const status = String(sub.status ?? "");
  if (["canceled", "unpaid", "incomplete_expired", "incomplete", "past_due"].includes(status)) return status;
  if (status === "trialing" && !Number(sub.has_sub)) {
    const live = !!(Number(sub.early_bird) && sub.trial_end && new Date(String(sub.trial_end)) > now);
    return live ? null : "trial_expired";
  }
  return null;
}

const REASON_PT: Record<string, string> = {
  trial_expired: "período experimental terminado, sem subscrição paga",
  canceled: "subscrição cancelada",
  unpaid: "subscrição por pagar",
  past_due: "pagamento em atraso",
  incomplete: "subscrição por concluir",
  incomplete_expired: "subscrição expirou antes de ser concluída",
  no_subscription: "sem subscrição para esta ligação",
};

export async function collectSuppressedMerchants(
  env: Env,
  options: { hours?: number } = {},
): Promise<SuppressedMerchant[]> {
  const hours = options.hours && options.hours > 0 ? options.hours : 24;
  const sinceIso = new Date(Date.now() - hours * 36e5).toISOString();
  const now = new Date();

  const subRows = await env.DB.prepare(
    `SELECT s.user_id, s.connection_key, s.status, s.trial_end, s.early_bird,
            CASE WHEN s.stripe_subscription_id IS NULL THEN 0 ELSE 1 END AS has_sub,
            COALESCE(u.role, '') AS role, COALESCE(u.is_inactive, 0) AS is_inactive
       FROM subscriptions s
       LEFT JOIN users u ON u.id = s.user_id`,
  ).all();

  const blocked: SuppressedMerchant[] = [];
  for (const row of ((subRows as any)?.results ?? []) as any[]) {
    // Admins are exempt from the gate, and a deactivated account is not a
    // merchant being let down — it is one that left.
    if (row.role === "superadmin" || row.role === "hiperadmin") continue;
    if (Number(row.is_inactive) === 1) continue;
    const reason = subscriptionBlocks(row, now);
    if (!reason) continue;
    blocked.push({
      user_id: row.user_id,
      displayName: row.user_id,
      connectionKey: row.connection_key ?? "?",
      reason,
      status: row.status ?? null,
      trialEnd: row.trial_end ?? null,
      refusals: 0,
      since: null,
      daysSilent: null,
    });
  }
  if (blocked.length === 0) return [];

  // How loud is each one? The gate records one incident per refused order, so
  // the count in the window is the number of sales that went uninvoiced.
  const incRows = await env.DB.prepare(
    `SELECT user_id, COALESCE(SUM(occurrences), 0) AS refusals, MIN(first_seen_at) AS since
       FROM incidents
      WHERE kind = 'subscription_inactive' AND last_seen_at >= ?
      GROUP BY user_id`,
  ).bind(sinceIso).all();
  const byUser = new Map<string, { refusals: number; since: string | null }>();
  for (const r of ((incRows as any)?.results ?? []) as any[]) {
    byUser.set(r.user_id, { refusals: Number(r.refusals) || 0, since: r.since ?? null });
  }

  // A merchant blocked before they ever sold anything is waiting to activate,
  // not going dark. The last document they issued is what tells the two apart.
  const lastDocRows = await env.DB.prepare(
    `SELECT user_id, MAX(created_at) AS last_at FROM processed_orders
      WHERE user_id IS NOT NULL GROUP BY user_id`,
  ).all();
  const lastDocByUser = new Map<string, string>();
  for (const r of ((lastDocRows as any)?.results ?? []) as any[]) {
    if (r.last_at) lastDocByUser.set(r.user_id, String(r.last_at));
  }

  const names = await new AppStorage(env).getMerchantDisplayNames(blocked.map((b) => b.user_id));
  for (const b of blocked) {
    b.displayName = names.get(b.user_id) || b.user_id;
    const inc = byUser.get(b.user_id);
    b.refusals = inc?.refusals ?? 0;
    b.since = inc?.since ?? null;
    const last = lastDocByUser.get(b.user_id);
    b.daysSilent = last ? Math.floor((Date.now() - Date.parse(last.replace(" ", "T"))) / 864e5) : null;
  }

  // Loudest first: a merchant being turned away right now matters more than one
  // that stopped selling months ago.
  blocked.sort((a, b) => b.refusals - a.refusals || (b.daysSilent ?? -1) - (a.daysSilent ?? -1));
  return blocked;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * One roll-up of everything the subscription gate is refusing, to the ops
 * address. Silent when nothing is being refused.
 */
export async function runSuppressionDigest(
  env: Env,
  options: { hours?: number; dryRun?: boolean } = {},
): Promise<SuppressionDigestResult> {
  const merchants = await collectSuppressedMerchants(env, options);
  const totalRefusals = merchants.reduce((a, m) => a + m.refusals, 0);
  const result: SuppressionDigestResult = {
    ranAt: new Date().toISOString(), merchants, totalRefusals, emailed: false,
  };

  // Only report merchants that are actually being turned away, or that HAVE
  // invoiced before and have now gone quiet. A brand-new account that has not
  // paid yet is pre-onboarding, which is a state, not a fault.
  const worthReporting = merchants.filter((m) => m.refusals > 0 || m.daysSilent !== null);
  if (worthReporting.length === 0 || options.dryRun) return result;

  const recipients = (env.KAPTA_DEV_EMAILS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (recipients.length === 0) return result;

  const rows = worthReporting.map((m) => {
    const why = REASON_PT[m.reason] ?? m.reason;
    const silent = m.daysSilent === null
      ? "nunca facturou"
      : `${m.daysSilent} dia(s) sem facturar`;
    const refused = m.refusals > 0
      ? `<strong>${m.refusals}</strong> venda(s) recusada(s) nas últimas 24h`
      : "nenhuma venda nova nas últimas 24h";
    return `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0"><strong>${escapeHtml(m.displayName)}</strong><br>
        <span style="color:#64748b;font-size:12px">${escapeHtml(m.connectionKey)}</span></td>
      <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0">${escapeHtml(why)}${
        m.trialEnd ? `<br><span style="color:#64748b;font-size:12px">até ${escapeHtml(String(m.trialEnd).slice(0, 10))}</span>` : ""
      }</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0">${refused}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0">${escapeHtml(silent)}</td>
    </tr>`;
  }).join("");

  const html = `
    <h2>Comerciantes que o Rioko não está a facturar</h2>
    <p>${worthReporting.length} conta(s) bloqueada(s) pela verificação de subscrição.
    ${totalRefusals > 0 ? `<strong>${totalRefusals} venda(s)</strong> recusada(s) nas últimas 24 horas.` : ""}</p>
    <table style="border-collapse:collapse;font-family:system-ui,sans-serif;font-size:14px">
      <tr style="text-align:left;color:#475569">
        <th style="padding:6px 10px">Cliente</th><th style="padding:6px 10px">Motivo</th>
        <th style="padding:6px 10px">Recusas</th><th style="padding:6px 10px">Silêncio</th>
      </tr>
      ${rows}
    </table>
    <p style="color:#64748b">Isto é comportamento intencional, não uma avaria: a subscrição terminou e o portão fechou.
    Está aqui porque a decisão de deixar assim, ou de reactivar, é de quem lê este email, e até agora não havia onde a ver.
    Para o valor em euros por facturar, correr <code>npm run audit:shopify</code>.</p>`;

  await sendEmail(env, {
    to: recipients,
    subject: `Rioko — ${worthReporting.length} cliente(s) sem facturação${totalRefusals > 0 ? `, ${totalRefusals} venda(s) recusada(s)` : ""}`,
    html,
  });
  result.emailed = true;
  return result;
}
