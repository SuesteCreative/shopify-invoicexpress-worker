import type { Env } from "../env";
import type { IRequestConfig } from "../storage";

export type SubscriptionGateResult =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Verifies the user's Kapta subscription before allowing IX emission.
 *
 * - Superadmins / hiperadmins are exempt.
 * - Active or trialing-with-payment-method status allows through.
 * - Any other status (canceled, unpaid, past_due, incomplete, expired trial) blocks.
 * - On lookup error, fails OPEN (logs warn) so a transient DB hiccup never
 *   blocks emission. Same behavior as the inlined version in orders-paid.ts.
 *
 * Extracted from src/handlers/orders-paid.ts in Phase 3 so Stripe-source
 * handlers can apply the same gate.
 *
 * Since migration 0044 an account can hold one subscription PER CONNECTION.
 * Callers pass the connection they are invoicing for; with
 * SUBSCRIPTION_PER_CONNECTION=1 that connection has to be paid for by itself,
 * and without the flag any live subscription on the account still lets the
 * whole account through, exactly as before.
 */
/** Which connection is asking. `<source_kind>:<destination_kind>`. */
export function connectionKeyOf(source?: string | null, destination?: string | null): string {
  const s = String(source ?? "").trim().toLowerCase();
  const d = String(destination ?? "").trim().toLowerCase();
  if (!s || !d) return "shopify:invoicexpress";
  return `${s}:${d}`;
}

/** A row is good for invoicing when it is paid up, or an early bird still inside its window. */
function rowAllows(sub: any, now: Date): boolean {
  if (!sub) return false;
  if (["canceled", "unpaid", "incomplete_expired", "incomplete", "past_due"].includes(sub.status)) return false;
  // Non-early-bird trialing without a Stripe sub is suspended — no invoices.
  if (sub.status === "trialing" && !sub.stripe_subscription_id) {
    return !!(sub.early_bird && sub.trial_end && new Date(sub.trial_end) > now);
  }
  return true;
}

export async function checkSubscriptionGate(
  env: Env,
  config: IRequestConfig,
  connection?: { source?: string | null; destination?: string | null },
): Promise<SubscriptionGateResult> {
  if (!config.user_id) return { allowed: true };

  try {
    const user: any = await env.DB.prepare("SELECT role FROM users WHERE id = ?").bind(config.user_id).first();
    const isAdminUser = user?.role === "superadmin" || user?.role === "hiperadmin";
    if (isAdminUser) return { allowed: true };

    const rows = await env.DB.prepare(
      "SELECT connection_key, status, trial_end, stripe_subscription_id, early_bird FROM subscriptions WHERE user_id = ?"
    ).bind(config.user_id).all();
    const subs: any[] = (rows as any)?.results ?? [];
    const now = new Date();

    // One subscription per connection (migration 0044), enforced only when the
    // flag says so. Off, the account is judged as a whole — which is what every
    // merchant signed up under, and flipping that without warning would stop
    // invoicing for the second integration of an account that has always had
    // one subscription. On, a connection pays for itself: this is the hole that
    // let a Shopify shop invoice for free on a subscription bought for Stripe.
    if (env.SUBSCRIPTION_PER_CONNECTION === "1" && connection) {
      const key = connectionKeyOf(connection.source, connection.destination);
      const sub = subs.find((r) => r.connection_key === key) ?? null;
      if (!rowAllows(sub, now)) {
        return {
          allowed: false,
          reason: sub ? `subscription_inactive (${sub.status}) for ${key}` : `no_subscription for ${key}`,
        };
      }
      return { allowed: true };
    }

    const allowed = subs.some((r) => rowAllows(r, now));
    if (!allowed) {
      const first = subs[0];
      return { allowed: false, reason: `subscription_inactive (${first?.status || "none"})` };
    }
    return { allowed: true };
  } catch (e: any) {
    console.warn(`[Rioko] Gate check failed (fail-open): ${e.message}`);
    return { allowed: true };
  }
}
