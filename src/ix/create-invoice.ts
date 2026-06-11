import { IxApi } from "../api/ix";

// Shared IX invoice creator with two safety nets, used by every create path
// (webhook pipeline + admin re-emit) so they behave identically.
//
// 1. Transient retry — the IX proxy (ix-proxy.kapta.app, shared hosting) is slow
//    and intermittently 5xx/times-out under load. A single-shot POST turned a
//    blip into an unbilled order. We retry transient failures with backoff.
//
// 2. Client-invalid fallback — IX rejects the whole document with DOC010
//    "Cliente não é válido / Fiscal não é válido" when the client object can't be
//    resolved (e.g. it matches a pre-existing IX client record stamped with an
//    invalid fiscal_id, keyed by `code`=customer.id). Observed on zoolagos: 26
//    paid PT orders failed with DOC010 even though their Shopify data carried no
//    NIF and was identical to orders that succeeded — i.e. the rejection was IX
//    client *state*, not our payload. On that error we re-POST with a sanitized
//    client so IX is forced to create a fresh, valid client instead of matching
//    the broken one. A no-NIF B2C sale is legally "Consumidor Final" in PT, so
//    this never produces a wrong document — worst case it drops the buyer's name.

type IxHeaders = { "x-account-name": string; "x-api-key": string; "x-env"?: "prod" | "dev" };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isClientInvalid(error: unknown): boolean {
  const s = JSON.stringify(error ?? "").toLowerCase();
  return (
    s.includes("doc010") ||
    s.includes("client is not valid") ||
    s.includes("cliente não é válido") ||
    s.includes("cliente nao e valido") ||
    s.includes("fiscal não é válido") ||
    s.includes("fiscal is invalid")
  );
}

/** Tier 1: keep human-readable fields, strip the ones that can poison client
 * resolution — fiscal_id (any invalid NIF), code (so IX can't match a broken
 * existing client), and phone. */
function sanitizeClientKeepName(client: any): any {
  if (!client || typeof client !== "object") return { name: "Consumidor Final", country: "Portugal" };
  const { fiscal_id, code, phone, ...rest } = client;
  return { ...rest, name: client.name || "Consumidor Final", country: client.country || "Portugal" };
}

/** Tier 2: bare Consumidor Final — last resort if even the named client is rejected. */
function bareConsumidorFinal(client: any): any {
  return { name: "Consumidor Final", country: (client && client.country) || "Portugal" };
}

/**
 * When a shop sets force_tax_rate > 0 it means "charge this rate on EVERY sale,
 * including foreign clients" (e.g. a PT ticket office: place-of-supply is always
 * PT, never intra-EU exempt). But the builder sends the line tax as a bare NUMBER
 * (the rate), and IX's `on_tax_fallback_search_tax_by_value` resolver then falls
 * back to "Isento" (0%) for non-PT clients because the matching account tax is
 * region PT. Result: foreign invoices wrongly went out at 0%.
 *
 * Fix (verified live against IX with a France client + IVA6 draft): send the tax
 * EXPLICITLY as the account's tax object {id,name,value}. IX then honours it for
 * any client country instead of falling back to Isento. We only do this for lines
 * whose numeric tax equals the forced rate, and only when force_tax_rate > 0, so
 * shops that legitimately exempt foreign sales (exports/OSS) are untouched.
 */
async function resolveExplicitForcedTax(
  ixHeaders: IxHeaders,
  data: any,
  forcedRates: number[],
): Promise<void> {
  const items: any[] = Array.isArray(data?.items) ? data.items : [];
  // Every positive forced rate (product force_tax_rate AND shipping
  // force_shipping_tax_rate) must be sent explicitly — otherwise a shipping line
  // carrying a forced rate different from the product rate still falls back to
  // Isento (0%) for foreign clients. Resolve the union of forced rates in ONE
  // taxes fetch and rewrite every numeric line whose tax matches one of them.
  const targets = Array.from(new Set(forcedRates.filter((r) => typeof r === "number" && r > 0)));
  if (targets.length === 0) return;
  if (!items.some((it) => typeof it?.tax === "number" && targets.includes(it.tax))) return;
  try {
    const { data: taxData, error } = await IxApi.v2.taxes.get({ headers: ixHeaders });
    if (error) return;
    const list: any[] = (taxData as any)?.taxes ?? (taxData as any)?.data?.taxes ?? (taxData as any)?.data ?? [];
    const explicitByRate = new Map<number, { id: number; name: string; value: number }>();
    for (const rate of targets) {
      const match = list.find((t: any) => Number(t?.value) === rate);
      if (match?.id) explicitByRate.set(rate, { id: Number(match.id), name: String(match.name), value: Number(match.value) });
    }
    if (explicitByRate.size === 0) return; // no matching account tax — leave numeric, let resolver try
    for (const it of items) {
      if (typeof it?.tax === "number" && explicitByRate.has(it.tax)) it.tax = explicitByRate.get(it.tax);
    }
  } catch {
    // best-effort: on any failure leave the numeric tax (current behaviour)
  }
}

export interface IxCreateOutcome {
  /** The raw IX SDK response of the attempt that was returned (success or final failure). */
  res: any;
  /** "none" | "sanitized-client" | "consumidor-final" — which path produced `res`. */
  via: "none" | "sanitized-client" | "consumidor-final";
}

/**
 * Create an IX document, retrying transient failures and falling back to a
 * sanitized client on DOC010. Returns the final SDK response; the caller checks
 * `res.data?.data?.id` exactly as before.
 */
export async function createIxInvoiceWithFallback(
  ixHeaders: IxHeaders,
  data: any,
  docType: "invoice" | "invoice_receipt",
  opts?: { forceTaxRate?: number | null; forceShippingTaxRate?: number | null },
): Promise<IxCreateOutcome> {
  const query = { resolvers: "on_tax_fallback_search_tax_by_value" as const };

  // 0. Force every positive forced rate (product + shipping) to be sent as an
  //    explicit account tax so IX applies it to foreign clients too (instead of
  //    falling back to Isento).
  const forcedRates = [opts?.forceTaxRate, opts?.forceShippingTaxRate]
    .filter((r): r is number => typeof r === "number" && r > 0);
  if (forcedRates.length > 0) {
    await resolveExplicitForcedTax(ixHeaders, data, forcedRates);
  }

  // 1. Normal create, with transient retry.
  let res: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await IxApi.v2.documents.post({ headers: ixHeaders, body: { data, type: docType }, query });
    if (res?.data?.data?.id) return { res, via: "none" };
    if (res?.error && isClientInvalid(res.error)) break; // deterministic — stop retrying, go to fallback
    if (attempt < 2) await sleep(400 * (attempt + 1)); // transient — back off and retry
  }

  // 2. Client-invalid fallback (tier 1: keep name, drop fiscal_id/code/phone).
  if (res?.error && isClientInvalid(res.error)) {
    const t1 = { ...data, client: sanitizeClientKeepName(data?.client) };
    const res1 = await IxApi.v2.documents.post({ headers: ixHeaders, body: { data: t1, type: docType }, query });
    if (res1?.data?.data?.id) return { res: res1, via: "sanitized-client" };

    // 3. Tier 2: bare Consumidor Final.
    if (res1?.error && isClientInvalid(res1.error)) {
      const t2 = { ...data, client: bareConsumidorFinal(data?.client) };
      const res2 = await IxApi.v2.documents.post({ headers: ixHeaders, body: { data: t2, type: docType }, query });
      return { res: res2, via: "consumidor-final" };
    }
    return { res: res1, via: "sanitized-client" };
  }

  return { res, via: "none" };
}
