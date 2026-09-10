import type { DestinationKind } from "../adapters/types";

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
  /**
   * Which connection kind this event belongs to. Absent means `"stripe"`, so
   * messages already sitting in the queue when this shipped keep resolving to
   * the restricted-key connection they were enqueued for.
   */
  sourceKind?: "stripe" | "stripe_connect";
  /**
   * Which destination this event's connection issues into.
   *
   * One account may run `stripe → invoicexpress` AND `stripe → moloni` at once:
   * they are different rows, with different series, exemption codes and tax
   * settings. The consumer used to load "an active connection for this user and
   * source", with no destination filter and no ORDER BY, so which of the two
   * issued the document was decided by SQLite.
   *
   * Absent means the enqueuer did not know — a message already in the queue when
   * this shipped, or an older admin replay. The consumer then falls back to the
   * oldest active connection and says so in the log.
   */
  destinationKind?: DestinationKind;
}
