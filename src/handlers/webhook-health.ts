import type { Env } from "../env";
import { AppStorage } from "../storage";
import { reportIncident } from "../services/incidents";

/**
 * Shopify webhooks were installed by hand and then never looked at again.
 *
 * Nothing re-registers them and nothing notices when they go: a reinstalled app,
 * a rotated token, someone tidying the webhook list in the Shopify admin, and the
 * shop simply stops sending orders. The platform sees no failure — no webhook is
 * indistinguishable from no sales — so the first signal is a merchant asking
 * where their invoices went. The nightly reconciliation sweep does eventually
 * re-derive the missing orders, which is precisely why this went unnoticed for
 * so long: the damage shows up as "the sweep is doing all the work" rather than
 * as an alarm.
 *
 * This checks each shop's registered webhooks against the four the pipeline
 * needs, re-registers what is missing, and says exactly which topic was gone.
 *
 * The registration logic is duplicated from the backoffice's activate/validate
 * routes rather than shared: they are separate deployables with no shared
 * package, and inventing one to hold two lists of four strings would cost more
 * than the duplication. Kept minimal and pinned by tests on both sides.
 */

/** The four topics the pipeline depends on, and where each must point. */
export const REQUIRED_WEBHOOKS = [
  { topic: "orders/create", path: "/webhooks/shopify/orders-created" },
  { topic: "orders/paid", path: "/webhooks/shopify/orders-paid" },
  { topic: "orders/updated", path: "/webhooks/shopify/orders-updated" },
  { topic: "refunds/create", path: "/webhooks/shopify/refunds-create" },
] as const;

export interface ShopifyWebhookRow {
  topic?: string;
  address?: string;
}

/**
 * Which required topics are absent or pointing somewhere else.
 *
 * Address is compared by prefix against our worker URL, because a hook pointing
 * at an old deployment is as broken as no hook at all while looking present in
 * the Shopify admin.
 */
export function diffShopifyWebhooks(existing: ShopifyWebhookRow[], workerUrl: string): string[] {
  const hooks = Array.isArray(existing) ? existing : [];
  const base = workerUrl.replace(/\/+$/, "");
  return REQUIRED_WEBHOOKS
    .filter((req) => !hooks.some((h) =>
      h?.topic === req.topic && typeof h?.address === "string" && h.address.startsWith(base)))
    .map((req) => req.topic);
}

export type ShopHealthOutcome =
  | { status: "healthy"; shop: string }
  | { status: "healed"; shop: string; topics: string[] }
  | { status: "heal_failed"; shop: string; topics: string[]; detail: string }
  | { status: "auth_failed"; shop: string }
  | { status: "no_scope"; shop: string }
  | { status: "unreachable"; shop: string; detail: string };

/** Classify the response to the webhook listing. Pure, so the mapping is testable. */
export function classifyListResponse(status: number): "ok" | "auth_failed" | "no_scope" | "unreachable" {
  if (status === 200) return "ok";
  if (status === 401) return "auth_failed";
  if (status === 403) return "no_scope";
  return "unreachable";
}

/**
 * 201 is a fresh hook; a 422 for uniqueness means it was there all along.
 *
 * Matched on the message alone, not on "address has already been taken": Shopify
 * keys the error by field, so the body reads `{"errors":{"address":["has already
 * been taken"]}}` and the field name is never adjacent to the message. The
 * backoffice's activate route checks for the adjacent form and therefore treats
 * this case as a failure.
 */
export function isRegistrationSuccess(status: number, bodyText: string): boolean {
  if (status === 201) return true;
  return status === 422 && /has already been taken/i.test(bodyText);
}

interface CheckOptions {
  workerUrl: string;
  /** Only touch these shops (manual runs). */
  shops?: string[];
  /** Report what would happen without registering anything. */
  dryRun?: boolean;
}

async function checkOneShop(
  env: Env,
  shopifyDomain: string,
  opts: CheckOptions,
): Promise<ShopHealthOutcome> {
  const storage = new AppStorage(env, shopifyDomain);
  const config = await storage.loadConfig();
  if (!config?.shopify_token) return { status: "unreachable", shop: shopifyDomain, detail: "no shopify token" };

  const apiVersion = config.shopify_api_version || "2026-01";
  const listUrl = `https://${shopifyDomain}/admin/api/${apiVersion}/webhooks.json`;

  let listRes: Response;
  try {
    listRes = await fetch(listUrl, { headers: { "X-Shopify-Access-Token": config.shopify_token } });
  } catch (e: any) {
    return { status: "unreachable", shop: shopifyDomain, detail: String(e?.message ?? e) };
  }

  const kind = classifyListResponse(listRes.status);
  if (kind === "auth_failed") return { status: "auth_failed", shop: shopifyDomain };
  if (kind === "no_scope") return { status: "no_scope", shop: shopifyDomain };
  if (kind === "unreachable") {
    return { status: "unreachable", shop: shopifyDomain, detail: `HTTP ${listRes.status}` };
  }

  const body = await listRes.json().catch(() => ({})) as { webhooks?: ShopifyWebhookRow[] };
  const missing = diffShopifyWebhooks(body.webhooks ?? [], opts.workerUrl);
  if (missing.length === 0) return { status: "healthy", shop: shopifyDomain };
  if (opts.dryRun) return { status: "healed", shop: shopifyDomain, topics: missing };

  const failures: string[] = [];
  for (const topic of missing) {
    const spec = REQUIRED_WEBHOOKS.find((r) => r.topic === topic)!;
    try {
      const res = await fetch(listUrl, {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": config.shopify_token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          webhook: { topic, address: `${opts.workerUrl.replace(/\/+$/, "")}${spec.path}`, format: "json" },
        }),
      });
      const text = await res.text();
      if (!isRegistrationSuccess(res.status, text)) {
        failures.push(`${topic}: HTTP ${res.status} ${text.slice(0, 200)}`);
      }
    } catch (e: any) {
      failures.push(`${topic}: ${String(e?.message ?? e)}`);
    }
  }

  if (failures.length > 0) {
    return { status: "heal_failed", shop: shopifyDomain, topics: missing, detail: failures.join(" | ") };
  }
  return { status: "healed", shop: shopifyDomain, topics: missing };
}

export interface WebhookHealthResult {
  checked: number;
  healthy: number;
  healed: number;
  failed: number;
  outcomes: ShopHealthOutcome[];
}

export async function runShopifyWebhookHealthCheck(
  env: Env,
  opts: { shops?: string[]; dryRun?: boolean } = {},
): Promise<WebhookHealthResult> {
  const workerUrl = env.WORKER_PUBLIC_URL;
  if (!workerUrl) {
    console.warn("[WebhookHealth] WORKER_PUBLIC_URL not set — skipping");
    return { checked: 0, healthy: 0, healed: 0, failed: 0, outcomes: [] };
  }

  const storage = new AppStorage(env);
  const integrations = await storage.listActiveShopifyIntegrations();
  const shops = opts.shops?.length
    ? integrations.filter((i) => opts.shops!.includes(i.shopify_domain))
    : integrations;

  const result: WebhookHealthResult = { checked: 0, healthy: 0, healed: 0, failed: 0, outcomes: [] };

  for (const { shopify_domain, user_id } of shops) {
    result.checked++;
    const outcome = await checkOneShop(env, shopify_domain, { workerUrl, dryRun: opts.dryRun });
    result.outcomes.push(outcome);

    if (outcome.status === "healthy") { result.healthy++; continue; }
    if (outcome.status === "healed") result.healed++; else result.failed++;
    if (opts.dryRun) continue;

    // A self-repaired shop is still reported, at warning: the repair worked, but
    // hooks disappearing is a pattern worth seeing rather than silently undoing.
    if (outcome.status === "healed") {
      // The hooks are installed now, so the bit says so. Only ever set, never
      // cleared: `webhooks_forced_at` exists because an operator sometimes knows
      // better than a check that cannot see past a missing scope.
      try {
        await env.DB.prepare("UPDATE integrations SET webhooks_active = 1 WHERE shopify_domain = ?")
          .bind(shopify_domain).run();
      } catch (e) {
        console.warn(`[WebhookHealth] could not set webhooks_active for ${shopify_domain}:`, e);
      }
      await reportIncident(env, {
        user_id, severity: "warning", kind: "webhook_missing", bucket: "daily",
        summary: `Webhooks em falta em ${shopify_domain} (${outcome.topics.join(", ")}) — reinstalados automaticamente.`,
        detail: {
          shop: shopify_domain, topics: outcome.topics, healed: true,
          message: `Os webhooks ${outcome.topics.join(", ")} não estavam registados nesta loja e foram reinstalados. As vendas ocorridas enquanto faltavam não chegaram por webhook; a reconciliação nocturna apanha-as.`,
        },
        connection_label: "shopify → invoicexpress",
        merchant_name: shopify_domain,
      });
    } else if (outcome.status === "auth_failed") {
      await reportIncident(env, {
        user_id, severity: "critical", kind: "auth_failure_source", bucket: "daily",
        summary: `Token Shopify recusado em ${shopify_domain} — nenhuma encomenda está a ser recebida.`,
        detail: {
          shop: shopify_domain,
          message: "O token de acesso Shopify desta loja foi recusado (401). Enquanto assim estiver não chegam encomendas nem é possível reinstalar webhooks. É preciso reconectar a loja em Integrações.",
        },
        connection_label: "shopify → invoicexpress",
        merchant_name: shopify_domain,
      });
    } else if (outcome.status === "no_scope") {
      await reportIncident(env, {
        user_id, severity: "warning", kind: "webhook_missing", bucket: "daily",
        summary: `Sem permissão para ler webhooks em ${shopify_domain} — não é possível confirmar se estão instalados.`,
        detail: {
          shop: shopify_domain,
          message: "O token desta loja não tem o scope read_webhooks, por isso a verificação não consegue dizer se os webhooks estão instalados nem reinstalá-los. Reinstalar a app com read_webhooks e write_webhooks resolve. O estado actual foi preservado, não desligado.",
        },
        connection_label: "shopify → invoicexpress",
        merchant_name: shopify_domain,
      });
    } else if (outcome.status === "heal_failed") {
      await reportIncident(env, {
        user_id, severity: "critical", kind: "webhook_missing", bucket: "daily",
        summary: `Webhooks em falta em ${shopify_domain} (${outcome.topics.join(", ")}) e a reinstalação falhou.`,
        detail: {
          shop: shopify_domain, topics: outcome.topics, healed: false,
          message: `Os webhooks ${outcome.topics.join(", ")} não estão registados e a tentativa de os reinstalar falhou: ${outcome.detail}`,
        },
        connection_label: "shopify → invoicexpress",
        merchant_name: shopify_domain,
      });
    }
    // `unreachable` is deliberately silent: a shop that does not answer once is
    // noise, and a shop that stops answering for good already surfaces as a
    // starved sweep.
  }

  console.log(
    `[WebhookHealth] checked=${result.checked} healthy=${result.healthy} healed=${result.healed} failed=${result.failed}`,
  );
  return result;
}
