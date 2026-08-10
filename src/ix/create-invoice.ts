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
//
// 3. Read-back verification — a 200 from IX is NOT proof that IX stored what we
//    sent. On 2026-08-02→05, 81 Zoo de Lagos sales were POSTed with 6% lines
//    (unit prices extracted net of 6%, pre-flight reconcile green) and came back
//    stored at 0% VAT: gross 54.72€ on a 58.00€ sale, no VAT declared. Nothing
//    noticed, because nothing ever re-read the document. We now read every
//    created document back and compare its money with the money we sent; a
//    document that disagrees is deleted and the create is reported as failed, so
//    the order stays visibly unbilled instead of turning into a silent draft.

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

/**
 * The EXACT total InvoiceXpress computes from a set of items: sum the
 * full-precision per-line gross, round ONCE. Mirrors IxBuilder.ixExpectedGross —
 * IX does not round per line, so a per-line model mis-predicts it by cents.
 */
export function ixExpectedTotals(items: any[]): { gross: number; vat: number } {
  let gross = 0, net = 0;
  for (const it of Array.isArray(items) ? items : []) {
    const rate = typeof it?.tax === "number" ? it.tax : Number(it?.tax?.value ?? 0);
    // `discount` (percentage) is the ONLY per-line discount IX honours — it
    // silently ignores `items[*].discount_amount`, so predicting the stored
    // total means ignoring it here too. Subtracting it would under-predict the
    // document and delete perfectly good invoices.
    const disc = Number(it?.discount ?? 0);
    const lineNet = Number(it?.unit_price) * Number(it?.quantity) * (1 - disc / 100);
    net += lineNet;
    gross += lineNet * (1 + rate / 100);
  }
  return {
    gross: Math.round(gross * 100) / 100,
    vat: Math.round((gross - net) * 100) / 100,
  };
}

/**
 * Read a freshly created document back and check IX stored the money we sent.
 * Returns null when it agrees, or a human reason when it does not.
 *
 * Only the totals are compared, deliberately: they are unambiguous and they are
 * what a fiscal document is judged on. The per-line `tax` block in the read-back
 * is NOT reliable enough to gate on — IX has been observed returning
 * `{id, name: null, value: null}` on lines whose stored amounts are correct.
 */
async function verifyStoredDocument(
  ixHeaders: IxHeaders,
  docId: number,
  sent: any,
): Promise<string | null> {
  // Two payload shapes make our total model incomplete: a document-level
  // `global_discount` (only the non-raw fallback emits one) and `retention`,
  // both applied by IX in ways this model does not reproduce. Predicting them
  // wrongly would delete a good document, so those documents are not judged
  // here — the pre-flight reconcile already guards their arithmetic.
  if (sent?.global_discount || sent?.retention) return null;

  const { data, error } = await IxApi.v2.documents.byId.get({ headers: ixHeaders, path: { id: docId } });
  const doc: any = (data as any)?.data;
  // Unreadable is not the same as wrong: a proxy blip on the read-back must not
  // cost us a good document. Let it through — the nightly sweep re-checks it.
  if (error || !doc) return null;

  const expected = ixExpectedTotals(sent?.items);
  const storedTotal = Number(doc.total);
  const storedVat = Number(doc.taxes);
  if (!Number.isFinite(storedTotal)) return null;

  if (Math.abs(storedTotal - expected.gross) > 0.011) {
    return `IX guardou um total diferente do enviado: ${storedTotal.toFixed(2)}€ vs ${expected.gross.toFixed(2)}€`;
  }
  if (Number.isFinite(storedVat) && Math.abs(storedVat - expected.vat) > 0.011) {
    return `IX guardou um IVA diferente do enviado: ${storedVat.toFixed(2)}€ vs ${expected.vat.toFixed(2)}€`;
  }
  return null;
}

/** Remove a document we refuse to keep. It is still a draft at this point. */
async function deleteRejectedDraft(
  ixHeaders: IxHeaders,
  docType: "invoice" | "invoice_receipt",
  docId: number,
): Promise<void> {
  try {
    await IxApi.v2.changeState.post({
      headers: ixHeaders,
      body: { type: docType, id: docId, state: "deleted" },
    });
  } catch (e) {
    console.error(`[Rioko] could not delete mis-stored document ${docId}:`, e);
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

  // Every success goes through here: a created document only counts as created
  // once IX's own copy of it holds the money we sent (see note 3 at the top).
  const accept = async (
    okRes: any,
    via: IxCreateOutcome["via"],
    sent: any,
  ): Promise<IxCreateOutcome> => {
    const docId = Number(okRes?.data?.data?.id);
    const mismatch = await verifyStoredDocument(ixHeaders, docId, sent);
    if (!mismatch) return { res: okRes, via };
    await deleteRejectedDraft(ixHeaders, docType, docId);
    console.error(`[Rioko] rejected document ${docId}: ${mismatch}`);
    return {
      res: { data: null, error: { message: mismatch, code: "IX_STORED_MISMATCH" } },
      via,
    };
  };

  // 1. Normal create, with transient retry.
  let res: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await IxApi.v2.documents.post({ headers: ixHeaders, body: { data, type: docType }, query });
    if (res?.data?.data?.id) return accept(res, "none", data);
    if (res?.error && isClientInvalid(res.error)) break; // deterministic — stop retrying, go to fallback
    if (attempt < 2) await sleep(400 * (attempt + 1)); // transient — back off and retry
  }

  // 2. Client-invalid fallback (tier 1: keep name, drop fiscal_id/code/phone).
  if (res?.error && isClientInvalid(res.error)) {
    const t1 = { ...data, client: sanitizeClientKeepName(data?.client) };
    const res1 = await IxApi.v2.documents.post({ headers: ixHeaders, body: { data: t1, type: docType }, query });
    if (res1?.data?.data?.id) return accept(res1, "sanitized-client", t1);

    // 3. Tier 2: bare Consumidor Final.
    if (res1?.error && isClientInvalid(res1.error)) {
      const t2 = { ...data, client: bareConsumidorFinal(data?.client) };
      const res2 = await IxApi.v2.documents.post({ headers: ixHeaders, body: { data: t2, type: docType }, query });
      if (res2?.data?.data?.id) return accept(res2, "consumidor-final", t2);
      return { res: res2, via: "consumidor-final" };
    }
    return { res: res1, via: "sanitized-client" };
  }

  return { res, via: "none" };
}
