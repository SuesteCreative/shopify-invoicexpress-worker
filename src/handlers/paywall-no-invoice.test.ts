/**
 * No invoice behind an order the subscription gate refused is not a failure.
 *
 * Artway Lda, 13-15/09/2026: orders/created was refused by the gate (as it
 * should be), then every orders/updated for those orders threw "Invoice not
 * found", went six times round the queue and raised a critical
 * queue_retry_exhausted. Seven of them, on top of the subscription_inactive
 * incidents that already recorded each order. refunds/create has the same shape.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const checkSubscriptionGate = vi.fn();
const saveLog = vi.fn();
const markWebhookAsProcessed = vi.fn();

vi.mock("../shopify", () => ({
  Shopify: class {
    normalizeOrder = async () => ({ normalized: { order: { id: 13435238777157 }, raw_order: { financial_status: "paid" } } });
  },
}));
vi.mock("../storage", () => ({
  AppStorage: class {
    getInvoiceByOrderId = async () => null;
    saveLog = (...a: any[]) => saveLog(...a);
    markWebhookAsProcessed = (...a: any[]) => markWebhookAsProcessed(...a);
  },
}));
vi.mock("../services/subscription-gate", () => ({ checkSubscriptionGate: (...a: any[]) => checkSubscriptionGate(...a) }));

const { handleOrderUpdated } = await import("./orders-updated");
const { handleRefundCreate } = await import("./refunds-create");

const env = {} as any;
const config = { user_id: "user_3FANuwJ3tEPTSAcqrgGCLelbPCx", shopify_domain: "eka0xw-nq.myshopify.com", only_invoice_when_paid: 1 } as any;
const BLOCKED = { allowed: false, reason: "subscription_inactive (trialing) for shopify:invoicexpress" };

beforeEach(() => {
  checkSubscriptionGate.mockReset();
  saveLog.mockReset();
  markWebhookAsProcessed.mockReset();
});

describe("orders/updated with no invoice", () => {
  it("acks a gate-blocked order with a 402 log instead of retrying", async () => {
    checkSubscriptionGate.mockResolvedValue(BLOCKED);

    await handleOrderUpdated(env, config, "wh_1", { id: 13435238777157 });

    expect(markWebhookAsProcessed).toHaveBeenCalledWith("wh_1", "orders/updated", "success");
    expect(saveLog.mock.calls.at(-1)![0]).toMatchObject({ status: 402, response: `Blocked: ${BLOCKED.reason} — no invoice to update` });
  });

  it("still throws for a paying shop, where orders/created may simply be late", async () => {
    checkSubscriptionGate.mockResolvedValue({ allowed: true });

    await expect(handleOrderUpdated(env, config, "wh_1", { id: 13435238777157 })).rejects.toThrow("Invoice not found");
  });
});

describe("refunds/create with no invoice", () => {
  it("acks a gate-blocked order with a 402 log instead of retrying", async () => {
    checkSubscriptionGate.mockResolvedValue(BLOCKED);

    await handleRefundCreate(env, config, "wh_2", { id: 1, order_id: 13435238777157 });

    expect(markWebhookAsProcessed).toHaveBeenCalledWith("wh_2", "refunds/create", "success");
    expect(saveLog.mock.calls.at(-1)![0]).toMatchObject({ status: 402, response: `Blocked: ${BLOCKED.reason} — no invoice to credit` });
  });

  it("still throws for a paying shop", async () => {
    checkSubscriptionGate.mockResolvedValue({ allowed: true });

    await expect(handleRefundCreate(env, config, "wh_2", { id: 1, order_id: 13435238777157 })).rejects.toThrow("Invoice not found");
  });
});
