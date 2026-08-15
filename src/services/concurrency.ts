/**
 * Map over items with a bounded number of in-flight promises.
 *
 * The ix-proxy (ix-proxy.kapta.app) sits on shared hosting and collapses under a
 * burst of ~200 simultaneous reads. A reconciliation once fired one fetch per
 * invoice via `Promise.all` with NO cap, so a 200-order shop hammered the proxy
 * with 200 parallel GETs. Half timed out, their metas came back null, and every
 * one of those *issued* invoices was then rendered as "Sem fatura emitida" — the
 * bug that made a merchant believe dozens of real invoices had vanished.
 *
 * Capping the concurrency keeps the proxy responsive so the reads actually
 * succeed. Anything that reads documents in bulk goes through here.
 *
 * Lived in reconciliation.ts as a file-local function until the document-verify
 * sweep needed the same protection; copying it would have been the same mistake
 * this codebase keeps paying for.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
