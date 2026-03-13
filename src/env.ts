import { Context } from "hono";
import { env } from "hono/adapter";

export interface Env {
  INVOICE_KV: KVNamespace;
  DB: D1Database;
  NORMALIZE_SHOPIFY_ORDER_API_KEY: string;
}

export function getEnv(ctx: Context<{ Bindings: Env }>): Env {
  return env(ctx);
}
