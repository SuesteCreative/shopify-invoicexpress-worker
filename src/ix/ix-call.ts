// Reusable timeout + transient-retry wrapper for InvoiceXpress proxy calls.
//
// All IX traffic goes through ix-proxy.kapta.app, which has NO client-level
// timeout or retry — only the invoice-CREATE path (createIxInvoiceWithFallback)
// retried. The proxy sits on shared hosting and was measured at 11.6s / timing
// out under load. An un-wrapped finalize / lookup / email call could therefore
// hang to the Worker's wall-clock limit (stalling the whole queue consumer) or
// fail on a transient 5xx with no retry, silently leaving an order un-finalised.
//
// `ixCall` bounds every wrapped call: a per-attempt timeout (the underlying
// request may linger but the caller stops waiting) plus jittered linear backoff,
// retrying on a throw/timeout OR — when `isOk` is supplied — on a returned
// `{ error }` shape (5xx/timeout). It does NOT retry deterministic 4xx; callers
// pass `isOk: r => !r.error` so a real validation error returns immediately.

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function withTimeout<T>(p: Promise<T>, ms: number, label?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`ixCall timeout after ${ms}ms${label ? ` (${label})` : ""}`)),
      ms,
    );
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export interface IxCallOptions<T> {
  /** Total attempts including the first. Default 3. */
  attempts?: number;
  /** Per-attempt timeout in ms. Default 10000. */
  timeoutMs?: number;
  /** Return true when the result is acceptable. When it returns false the
   *  result is treated as a retryable transient (e.g. an SDK `{ error }`). */
  isOk?: (result: T) => boolean;
  /** Short label for the timeout message / diagnostics. */
  label?: string;
}

export async function ixCall<T>(fn: () => Promise<T>, opts: IxCallOptions<T> = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 10000;
  let lastResult: T | undefined;
  let lastErr: unknown;
  let haveResult = false;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const result = await withTimeout(fn(), timeoutMs, opts.label);
      if (!opts.isOk || opts.isOk(result)) return result;
      lastResult = result; // transient (e.g. {error}) — keep as fallback, retry
      haveResult = true;
    } catch (e) {
      lastErr = e;
    }
    if (attempt < attempts - 1) await sleep(400 * (attempt + 1));
  }

  // Exhausted: prefer returning the last SDK result (so callers see the real
  // {error}) over throwing a bare timeout, unless we never got a result at all.
  if (haveResult) return lastResult as T;
  throw lastErr;
}
