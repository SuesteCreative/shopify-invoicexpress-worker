import type { Env } from "../env";
import type { IRequestConfig } from "../storage";
import { AppStorage } from "../storage";

/**
 * Short-circuits a webhook when the merchant has paused the integration.
 *
 * Returns true when the caller should stop processing (no destination call).
 * Logs the skip as status 200 — the event reached us and was honoured; we
 * just didn't generate a document. Distinct from the subscription gate
 * (which is status 402 / merchant-must-pay).
 */
export async function isIntegrationPaused(
  env: Env,
  config: IRequestConfig,
  topic: string,
  externalId: string | number | null,
): Promise<boolean> {
  if (config.is_paused !== 1) return false;

  const appStorage = new AppStorage(env, config.shopify_domain ?? undefined);
  await appStorage.saveLog({
    shopify_domain: config.shopify_domain,
    topic,
    payload: String(externalId ?? ""),
    response: "Skipped: integration paused by merchant",
    status: 200,
  });
  console.log(`[Rioko] Integration paused — skipping ${topic} ${externalId}`);
  return true;
}
