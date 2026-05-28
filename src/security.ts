import type { Context } from "hono";
import type { Env } from "./env";

const SECRET_KEYS = new Set([
  "client_secret",
  "password",
  "access_token",
  "refresh_token",
  "api_key",
  "apiKey",
  "x-api-key",
  "shopify_token",
  "shopify_webhook_secret",
  "ix_api_key",
  "hmac_secret",
  "stripe_secret_key",
  "authorization",
]);

export function redactSecrets<T>(value: T): T {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactSecrets) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.has(k.toLowerCase())) {
      out[k] = v ? "[REDACTED]" : v;
    } else if (v && typeof v === "object") {
      out[k] = redactSecrets(v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export function errorResponse(
  c: Context<{ Bindings: Env }>,
  e: unknown,
  publicMessage = "Internal error",
  status: 400 | 401 | 404 | 409 | 500 = 500,
) {
  const requestId =
    c.req.header("cf-ray") ?? crypto.randomUUID().slice(0, 8);
  console.error(
    `[Rioko][error] ${publicMessage} (req=${requestId})`,
    e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : e,
  );
  return c.json({ error: publicMessage, request_id: requestId }, status);
}

const encoder = new TextEncoder();

export function timingSafeEqualStr(a: string, b: string): boolean {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  const len = Math.max(aBytes.length, bBytes.length, 1);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

const AUTH_FAIL_WINDOW_SECONDS = 300;
const AUTH_FAIL_THRESHOLD = 10;

export async function isAuthIpBlocked(env: Env, ip: string): Promise<boolean> {
  if (!ip || !env.INVOICE_KV) return false;
  const raw = await env.INVOICE_KV.get(`auth:fail:${ip}`);
  if (!raw) return false;
  const n = Number(raw);
  return Number.isFinite(n) && n >= AUTH_FAIL_THRESHOLD;
}

export async function recordAuthFail(env: Env, ip: string): Promise<void> {
  if (!ip || !env.INVOICE_KV) return;
  const key = `auth:fail:${ip}`;
  const raw = await env.INVOICE_KV.get(key);
  const next = (raw ? Number(raw) : 0) + 1;
  await env.INVOICE_KV.put(key, String(next), {
    expirationTtl: AUTH_FAIL_WINDOW_SECONDS,
  });
}

export async function requireAdminAuth(
  c: Context<{ Bindings: Env }>,
): Promise<Response | null> {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const apiKey = c.req.header("x-api-key") ?? "";
  const expected = c.env.ADMIN_API_KEY ?? "";

  if (await isAuthIpBlocked(c.env, ip)) {
    console.warn(`[Rioko][Auth] 429 rate-limited ip=${ip}`);
    return c.json({ error: "Too many requests" }, 429);
  }

  if (!apiKey || !expected || !timingSafeEqualStr(apiKey, expected)) {
    await recordAuthFail(c.env, ip);
    console.warn(`[Rioko][Auth] 401 ip=${ip} path=${new URL(c.req.url).pathname}`);
    return c.json({ error: "Unauthorized" }, 401);
  }
  return null;
}
