// VIES VAT validator. Calls the EU Commission REST endpoint with a tight
// timeout, caches both positive AND negative results in KV for 24h to keep us
// well under the ~30 req/min/IP soft limit.
//
// Return semantics:
//   true  → definitive valid → safe to apply reverse charge
//   false → definitive invalid → fall through to B2C invoice (no retry)
//   null  → unknown (timeout / 5xx / network) → caller queues for retry

const VIES_ENDPOINT = "https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number";
const CACHE_TTL_SECONDS = 24 * 60 * 60;
const TIMEOUT_MS = 2500;

type CacheValue = "1" | "0";

function cacheKey(countryCode: string, vatNumber: string): string {
  return `vies:${countryCode.toUpperCase()}:${vatNumber}`;
}

function stripVat(raw: string): { countryCode: string; vatNumber: string } | null {
  const cleaned = raw.replace(/[\s\-.]/g, "").toUpperCase();
  const m = cleaned.match(/^([A-Z]{2})?([0-9A-Z]+)$/);
  if (!m) return null;
  if (m[1]) return { countryCode: m[1], vatNumber: m[2] };
  return { countryCode: "", vatNumber: m[2] };
}

export type ViesChecker = (countryCode: string, vatNumber: string) => Promise<boolean | null>;

export function makeViesChecker(kv: KVNamespace): ViesChecker {
  return async (countryCodeRaw, vatNumberRaw) => {
    const parsed = stripVat(`${countryCodeRaw}${vatNumberRaw}`);
    if (!parsed || !parsed.countryCode || !parsed.vatNumber) return false;

    const { countryCode, vatNumber } = parsed;
    const key = cacheKey(countryCode, vatNumber);

    try {
      const cached = await kv.get(key);
      if (cached === "1") return true;
      if (cached === "0") return false;
    } catch (e: any) {
      console.warn(`[VIES] KV read failed for ${key}: ${e.message}`);
    }

    let result: boolean | null = null;
    try {
      const res = await fetch(VIES_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ countryCode, vatNumber }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!res.ok) {
        console.warn(`[VIES] HTTP ${res.status} for ${countryCode}${vatNumber}`);
        return null;
      }

      const body: any = await res.json();
      if (typeof body?.valid === "boolean") {
        result = body.valid;
      } else {
        return null;
      }
    } catch (e: any) {
      console.warn(`[VIES] fetch error for ${countryCode}${vatNumber}: ${e.message}`);
      return null;
    }

    if (result !== null) {
      try {
        await kv.put(key, (result ? "1" : "0") satisfies CacheValue, { expirationTtl: CACHE_TTL_SECONDS });
      } catch (e: any) {
        console.warn(`[VIES] KV write failed for ${key}: ${e.message}`);
      }
    }
    return result;
  };
}
