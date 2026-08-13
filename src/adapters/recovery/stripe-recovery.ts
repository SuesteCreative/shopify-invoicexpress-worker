import type { Env } from "../../env";
import type { ConnectionContext } from "../../services/connection-context";
import type { SourceRecovery, SourceRecordRef, SourceDescription } from "./types";
import { listStripePaymentIntents, fetchStripeObject } from "../../services/stripe";
import { getSourceAdapter } from "../registry";

function restrictedKeyOf(ctx: ConnectionContext): string {
  const key = ctx.sourceConfig?.restricted_key;
  if (!key) throw new Error("No Stripe restricted_key on the connection");
  return String(key);
}

/**
 * The id the pipeline will dedup on.
 *
 * Asked of the source adapter rather than recomputed here. A hand-kept mirror of
 * `StripeSource.externalId` used to live in admin-stripe.ts, with a comment
 * explaining that it MUST stay in sync — which is the definition of a bug
 * waiting for someone to edit one and not the other.
 */
function externalIdOf(event: any): string {
  return getSourceAdapter("stripe").externalId(event);
}

function toRecord(pi: any, event: any): SourceRecordRef {
  const amount = Number(pi?.amount);
  return {
    externalId: externalIdOf(event),
    // Stripe has no order numbers. Declared as such by StripeSource.capabilities
    // so the panel hides the order-range filter instead of offering a dead one.
    orderNumber: null,
    label: String(pi?.id ?? ""),
    paidTotal: Number.isFinite(amount) ? amount / 100 : null,
    paidAt: pi?.created ? new Date(pi.created * 1000).toISOString() : null,
    replayBody: event,
    blocker: pi?.status === "succeeded" ? null : `pagamento não concluído (status=${pi?.status})`,
  };
}

export class StripeRecovery implements SourceRecovery {
  readonly kind = "stripe" as const;

  /** Accepts any of `pi_…`, `ch_…`, `cs_…`, `in_…`. */
  async resolveRecord(input: string, ctx: ConnectionContext, _env: Env): Promise<SourceRecordRef | null> {
    const stripeId = input.trim();
    const fetched = await fetchStripeObject(restrictedKeyOf(ctx), stripeId, ctx.sourceConfig?.stripe_account_id);
    if ("error" in fetched) throw new Error(fetched.error);

    const obj = fetched.event?.data?.object;
    return toRecord(obj, fetched.event);
  }

  async listCandidates(
    ctx: ConnectionContext,
    _env: Env,
    window: { from: string; to: string; limit: number },
  ): Promise<SourceRecordRef[]> {
    const pis = await listStripePaymentIntents(
      restrictedKeyOf(ctx), window.from, window.to, window.limit, ctx.sourceConfig?.stripe_account_id,
    );
    return pis.map((pi) => {
      const event = {
        type: "payment_intent.succeeded",
        data: { object: pi },
        ...(ctx.sourceConfig?.stripe_account_id ? { account: ctx.sourceConfig.stripe_account_id } : {}),
      };
      return toRecord(pi, event);
    });
  }

  /**
   * Paid totals for already-invoiced payments, so finalize can refuse to certify
   * a document whose total drifted from what was actually charged.
   *
   * New capability: the Stripe finalize path used to certify without any such
   * check, while the Shopify one has refused on more than a cent of drift since
   * the 0%-VAT incident.
   */
  async describe(externalIds: string[], ctx: ConnectionContext, _env: Env): Promise<Map<string, SourceDescription>> {
    const map = new Map<string, SourceDescription>();
    const key = restrictedKeyOf(ctx);
    const account = ctx.sourceConfig?.stripe_account_id;

    // One read per id: Stripe's list endpoint cannot filter by an id set, and a
    // recovery run is bounded (limit-capped) by design.
    for (const id of externalIds) {
      try {
        const fetched = await fetchStripeObject(key, id, account);
        if ("error" in fetched) continue;
        const obj = fetched.event?.data?.object;
        const amount = Number(obj?.amount);
        map.set(id, {
          orderNumber: null,
          paidTotal: Number.isFinite(amount) ? amount / 100 : null,
          paidAt: obj?.created ? new Date(obj.created * 1000).toISOString() : null,
        });
      } catch {
        // A read we could not make is "cannot answer", not "zero" — leaving the
        // id out of the map is what says so.
      }
    }
    return map;
  }
}
