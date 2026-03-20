export type WebhookTopic = "orders/created" | "orders/updated" | "orders/paid" | "refunds/create";

export interface QueueMessage {
  topic: WebhookTopic;
  webhookId: string | null;
  shopDomain: string;
  body: any;
}
