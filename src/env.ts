export interface Env {
  INVOICE_KV: KVNamespace;
  DB: D1Database;
  NORMALIZE_SHOPIFY_ORDER_API_KEY: string;
  SHOPIFY_ORDERS_QUEUE: Queue;
}
