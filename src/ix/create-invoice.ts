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
): Promise<IxCreateOutcome> {
  const query = { resolvers: "on_tax_fallback_search_tax_by_value" as const };

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
