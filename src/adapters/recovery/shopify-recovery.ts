import type { Env } from "../../env";
import type { ConnectionContext } from "../../services/connection-context";
import type { SourceRecovery, SourceRecordRef, SourceDescription } from "./types";
import {
  fetchShopifyOrders, fetchOrdersByIds, fetchShopifyOrderByNumber, shopifyOrderNotFoundHint,
} from "../../services/shopify-orders";

/** A raw Shopify order is already the webhook body shape the pipeline expects. */
function toRecord(order: any): SourceRecordRef {
  const total = Number(order?.total_price);
  return {
    externalId: String(order.id),
    orderNumber: Number.isFinite(Number(order.order_number)) ? Number(order.order_number) : null,
    label: order.name ?? `#${order.order_number ?? order.id}`,
    paidTotal: Number.isFinite(total) ? total : null,
    paidAt: order.processed_at ?? order.created_at ?? null,
    replayBody: order,
    // Auto-heal must never invoice an order that has since been refunded or
    // cancelled, so anything other than a clean `paid` is a blocker, not a bill.
    blocker: order.financial_status === "paid"
      ? null
      : `não está pago (financial_status=${order.financial_status})`,
  };
}

export class ShopifyRecovery implements SourceRecovery {
  readonly kind = "shopify" as const;

  /**
   * Accepts the order NUMBER an operator reads off the storefront ("1137",
   * "#1137"). A long all-digits input is treated as an order id instead, since
   * Shopify order ids are 13+ digits and cannot be confused with a number.
   */
  async resolveRecord(input: string, ctx: ConnectionContext, _env: Env): Promise<SourceRecordRef | null> {
    const cleaned = input.trim().replace(/^#/, "");
    const looksLikeOrderId = /^\d{10,}$/.test(cleaned);

    const order = looksLikeOrderId
      ? (await fetchOrdersByIds(ctx.config, [Number(cleaned)]))[0] ?? null
      : await fetchShopifyOrderByNumber(ctx.config, cleaned);

    if (!order) throw new Error(shopifyOrderNotFoundHint(cleaned));
    return toRecord(order);
  }

  async listCandidates(
    ctx: ConnectionContext,
    _env: Env,
    window: { from: string; to: string; limit: number },
  ): Promise<SourceRecordRef[]> {
    const orders = await fetchShopifyOrders(ctx.config, window.from, window.to);
    return orders.slice(0, window.limit).map(toRecord);
  }

  async describe(externalIds: string[], ctx: ConnectionContext, _env: Env): Promise<Map<string, SourceDescription>> {
    const map = new Map<string, SourceDescription>();
    const ids = externalIds.map(Number).filter((n) => Number.isFinite(n));
    if (ids.length === 0) return map;

    // Shopify caps `ids=` at 250 per call.
    for (let i = 0; i < ids.length; i += 250) {
      const orders = await fetchOrdersByIds(ctx.config, ids.slice(i, i + 250));
      for (const o of orders) {
        const total = Number(o?.total_price);
        map.set(String(o.id), {
          orderNumber: Number.isFinite(Number(o.order_number)) ? Number(o.order_number) : null,
          paidTotal: Number.isFinite(total) ? total : null,
          paidAt: o.processed_at ?? o.created_at ?? null,
        });
      }
    }
    return map;
  }
}
