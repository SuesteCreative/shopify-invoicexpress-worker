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
 * - A trialing row with a future `trial_end` is inside its free-access window
 *   (early bird, admin grace, …) and allows through.
 * - Any other status (canceled, unpaid, past_due, incomplete, expired trial) blocks.
 * - On lookup error, fails OPEN (logs warn) so a transient DB hiccup never
 *   blocks emission. Same behavior as the inlined version in orders-paid.ts.
 *
 * Extracted from src/handlers/orders-paid.ts in Phase 3 so Stripe-source
 * handlers can apply the same gate.
 */
export async function checkSubscriptionGate(env: Env, config: IRequestConfig): Promise<SubscriptionGateResult> {
  if (!config.user_id) return { allowed: true };

  try {
    const user: any = await env.DB.prepare("SELECT role FROM users WHERE id = ?").bind(config.user_id).first();
    const isAdminUser = user?.role === "superadmin" || user?.role === "hiperadmin";
    if (isAdminUser) return { allowed: true };

    const sub: any = await env.DB.prepare(
      "SELECT status, trial_end, stripe_subscription_id FROM subscriptions WHERE user_id = ?"
    ).bind(config.user_id).first();

    // Must pay to invoice: blocked unless active, exempt, a paying Stripe trial
    // (has stripe_subscription_id), or inside a free-access window.
    //
    // The window is `trial_end` alone — `early_bird` is only a label for WHY it
    // was granted. Gating on the flag made every non-early-bird trial_end dead
    // data, including the 3-day grace Dev Mode writes when an admin turns early
    // bird off: the date was stored, ignored, and access cut instantly.
    // No trial_end (or a past one) without a Stripe sub is suspended — no invoices.
    const now = new Date();
    const blocked = !sub
      || ["canceled", "unpaid", "incomplete_expired", "incomplete", "past_due"].includes(sub.status)
      || (sub.status === "trialing" && !sub.stripe_subscription_id
          && !(sub.trial_end && new Date(sub.trial_end) > now));

    if (blocked) return { allowed: false, reason: `subscription_inactive (${sub?.status || "none"})` };
    return { allowed: true };
  } catch (e: any) {
    console.warn(`[Rioko] Gate check failed (fail-open): ${e.message}`);
    return { allowed: true };
  }
}
