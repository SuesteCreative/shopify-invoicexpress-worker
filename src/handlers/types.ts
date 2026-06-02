export type WebhookTopic = "orders/created" | "orders/updated" | "orders/paid" | "refunds/create";

export interface QueueMessage {
  topic: WebhookTopic;
  webhookId: string | null;
  shopDomain: string;
  body: any;
}

export type StripeCanonicalTopic = "created" | "paid" | "refund";

export interface StripeQueueMessage {
  topic: StripeCanonicalTopic;
  /** Stripe event id, used both as idempotency anchor and webhook_info row id. */
  eventId: string;
  /** The user_id of the merchant owning the Stripe-source connection. */
  userId: string;
  /** Stripe event payload (data.object etc.). Omitted when spilled to KV — see bodyRef. */
  body?: any;
  /**
   * KV key holding the full event JSON when the payload exceeds the Cloudflare
   * Queues 128KB per-message limit. The consumer hydrates `body` from here.
   */
  bodyRef?: string;
}
