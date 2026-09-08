import { client } from "./client/client.gen";

/**
 * Which InvoiceXpress proxy this worker talks to.
 *
 * The generated client bakes in a base URL, which was fine while there was only
 * ever one proxy. There are now two: `ix-proxy.kapta.app`, whose source we no
 * longer have, and `ix.rioko.online`, which is ours (see `ix-proxy/` in this
 * repo). The cutover has to be a var flip rather than a deploy, because the
 * thing being swapped sits between us and every fiscal document we issue, and
 * the answer to "it went wrong" has to be faster than a build.
 *
 * Default is the OLD proxy: nothing moves until `IX_PROXY_URL` says so, and
 * putting the old URL back is the rollback.
 */
const DEFAULT_IX_PROXY = "https://ix-proxy.kapta.app";

let applied: string | null = null;

export function configureIxBaseUrl(env: { IX_PROXY_URL?: string }): void {
  const target = String(env?.IX_PROXY_URL ?? "").trim() || DEFAULT_IX_PROXY;
  // Set once per isolate, and again only if the var actually changed — the
  // client is a module singleton and reconfiguring it on every request would
  // race with in-flight calls.
  if (applied === target) return;
  client.setConfig({ baseUrl: target });
  applied = target;
  console.log(`[IX] proxy base URL: ${target}`);
}
