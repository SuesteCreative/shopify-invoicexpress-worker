import type { IRequestConfig } from "../../storage";
import type { AdapterCtx, FinalizeDateStrategy, FinalizeOutcome } from "../types";
import { IxApi } from "../../api/ix";
import { ixExpectedTotals } from "../../ix/create-invoice";
import { parseIxDate, formatPtDate, todayUtcYmd } from "../../ix/date";
import { resolveExemptionCode } from "../../ix/exemption";

/**
 * Certifying a draft in InvoiceXpress, and the date negotiation that goes with it.
 *
 * Split out of the adapter because it is the single most load-bearing piece of
 * IX-specific knowledge we have: IX refuses to finalize a document dated behind
 * the last finalized document in its series, refuses a due_date behind the issue
 * date, refuses a 0% line with no exemption reason, and — under load — refuses
 * perfectly valid payloads with a spurious validation error. Each of those cost
 * a production incident to learn.
 */

export type IxDocKind = "invoice" | "invoice_receipt";

// A type alias, not an interface: the generated IX client wants headers that are
// assignable to Record<string, string>, and only type aliases get the implicit
// index signature that makes that work.
export type IxHeaders = {
  "x-account-name": string;
  "x-api-key": string;
  "x-env": "prod" | "dev";
};

/**
 * IX is saying the document is already certified.
 *
 * Worth the long list: a sweep that reads these as failures reports healthy
 * documents as errors and buries the real ones — one nightly run announced "422
 * orders could not be auto-invoiced" for a shop whose genuine failures numbered
 * two.
 */
export function isAlreadyFinalizedIxError(error: unknown): boolean {
  const s = JSON.stringify(error ?? "").toLowerCase();
  return (
    s.includes("doc001") ||
    s.includes("doc009") ||
    s.includes("already paid") ||
    s.includes("cannot be edited") ||
    s.includes("can't be edited") ||
    s.includes("has payments") ||
    s.includes("has been finalized") ||
    s.includes("can't be changed") ||
    s.includes("cannot be changed") ||
    s.includes("in status 'settled'") ||
    s.includes("já contém pagamentos") ||
    s.includes("ja contem pagamentos") ||
    s.includes("não pode ser editado") ||
    s.includes("nao pode ser editado") ||
    s.includes("já foi finalizado") ||
    s.includes("ja foi finalizado") ||
    s.includes("não pode ser alterado") ||
    s.includes("nao pode ser alterado")
  );
}

/**
 * IX refused the document's DATE, not the document. Two shapes matter:
 * "Vencimento deve ser igual ou posterior à data do documento" (the due date is
 * behind the issue date) and the series' chronology rule, which IX words as
 * "Date cannot be earlier than the last invoice-receipt of this sequence[02 Aug
 * 26]". Both are fixable by moving the document forward, so a caller on the
 * escalating strategy retries with the next candidate date instead of giving up.
 *
 * Verified live 2026-08-07: IX DOES accept a backdated finalize as long as the
 * date is not behind the series' last issued document, so a draft can usually
 * keep the day the sale actually happened.
 */
export function isDateRejectionIxError(error: unknown): boolean {
  const s = JSON.stringify(error ?? "").toLowerCase();
  return (
    s.includes("vencimento") ||
    s.includes("due date") ||
    s.includes("data do documento") ||
    s.includes("document date") ||
    s.includes("data de emiss") ||
    s.includes("issue date") ||
    s.includes("sequencial") ||
    s.includes("sequential") ||
    s.includes("sequence") ||
    s.includes("sequência") ||
    s.includes("date cannot be earlier") ||
    s.includes("não pode ser anterior") ||
    s.includes("nao pode ser anterior")
  );
}

/**
 * The account's own tax table, id → {name, value}. Fetched once per run and
 * handed to every document rebuild so a line whose read-back carries a null rate
 * can be restored to the rate it actually has, instead of being renamed "Isento"
 * and silently zeroed.
 */
export async function fetchAccountTaxes(headers: IxHeaders): Promise<Map<number, { name: string; value: number }>> {
  const map = new Map<number, { name: string; value: number }>();
  try {
    const { data, error } = await IxApi.v2.taxes.get({ headers });
    if (error) return map;
    const list: any[] = (data as any)?.taxes ?? (data as any)?.data?.taxes ?? (data as any)?.data ?? [];
    for (const t of Array.isArray(list) ? list : []) {
      const id = Number(t?.id);
      const value = Number(t?.value);
      const name = String(t?.name ?? "").trim();
      if (Number.isFinite(id) && Number.isFinite(value) && name) map.set(id, { name, value });
    }
  } catch (e) {
    console.error("[Rioko] could not read the account tax table:", e);
  }
  return map;
}

/**
 * The most recent finalized document date in the account's series.
 *
 * IX rejects `changeState → finalized` when the document's date is earlier than
 * this, so it is the baseline every date strategy negotiates against. Hits the
 * legacy JSON endpoint directly since the v2 proxy exposes no list endpoint.
 */
export async function fetchSeriesLastFinalizedDate(
  config: IRequestConfig,
  docKind: IxDocKind,
): Promise<string | null> {
  try {
    const account = config.ix_account_name;
    const apiKey = config.ix_api_key;
    if (!account || !apiKey) return null;
    const path = docKind === "invoice_receipt" ? "invoice_receipts.json" : "invoices.json";
    const url = `https://${account}.app.invoicexpress.com/${path}?api_key=${apiKey}&status%5B%5D=settled&status%5B%5D=final&order_by=date_desc&per_page=1`;
    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const list = data?.invoices ?? data?.invoice_receipts ?? [];
    if (!Array.isArray(list) || list.length === 0) return null;
    return parseIxDate(list[0]?.date ?? null);
  } catch (e) {
    console.warn("[Rioko] fetchSeriesLastFinalizedDate failed:", e);
    return null;
  }
}

/**
 * Rebuilds a draft's editable payload with a new date. IX's PUT replaces the
 * document, so client and items have to be sent back verbatim — dropping them
 * would blank the document.
 *
 * `due_date` moves WITH `date`. That is not cosmetic: IX validates
 * `due_date >= date` and answers "Vencimento deve ser igual ou posterior à data
 * do documento" when it doesn't, which is exactly how every retro-finalize in
 * the fleet was failing.
 */
export function buildIxDatePutBody(
  doc: any,
  ixDocType: IxDocKind,
  targetDate: string,
  observations: string,
  ctx: { accountTaxes: Map<number, { name: string; value: number }>; exemptionReason?: string | null },
): any {
  // Every name we send has to be non-empty — the proxy rejects the whole
  // document with "… name must be at least 1 character" and the message does
  // not say which field it means. A Portuguese B2C sale legitimately has no
  // buyer name, and that is exactly what "Consumidor Final" is for.
  //
  // The tax is the dangerous one. IX resolves a line by the NAME and VALUE we
  // send (verified live: send the Isento id with name IVA6/value 6 and you get
  // IVA6 back), and its read-back sometimes carries `{id, name: null, value:
  // null}` on lines whose stored amounts are perfectly correct. The old code
  // read that null as zero and renamed the line "Isento" — so a date change
  // would have restated a 6% document as exempt. Resolve the id against the
  // account's own tax table instead, and refuse the document when we cannot.
  const taxFor = (tax: any) => {
    const rawValue = Number(tax?.value);
    const rawName = String(tax?.name ?? "").trim();
    if (Number.isFinite(rawValue) && rawName) {
      return tax?.id ? { id: Number(tax.id), name: rawName, value: rawValue } : { name: rawName, value: rawValue };
    }
    const resolved = tax?.id != null ? ctx.accountTaxes.get(Number(tax.id)) : undefined;
    if (resolved) return { id: Number(tax.id), name: resolved.name, value: resolved.value };
    throw new Error(
      `Não consigo reler a taxa da linha (${JSON.stringify(tax ?? null)}) — não reescrevo o documento às cegas`,
    );
  };

  const items = Array.isArray(doc.items) ? doc.items.map((it: any) => ({
    quantity: Number(it.quantity),
    name: String(it.name ?? "").trim() || "Artigo",
    ...(it.description ? { description: String(it.description) } : {}),
    unit_price: Number(it.unit_price),
    tax: taxFor(it.tax),
    ...(typeof it.discount === "number" && it.discount > 0 ? { discount: it.discount } : {}),
  })) : [];

  const client = doc.client ? {
    ...(doc.client.id ? { id: Number(doc.client.id) } : {}),
    name: String(doc.client.name ?? "").trim() || "Consumidor Final",
    ...(doc.client.email ? { email: String(doc.client.email) } : {}),
    ...(doc.client.fiscal_id ? { fiscal_id: String(doc.client.fiscal_id) } : {}),
    ...(doc.client.address ? { address: String(doc.client.address) } : {}),
    ...(doc.client.postal_code ? { postal_code: String(doc.client.postal_code) } : {}),
    ...(doc.client.country ? { country: String(doc.client.country) } : {}),
    ...(doc.client.city ? { city: String(doc.client.city) } : {}),
    ...(doc.client.phone ? { phone: String(doc.client.phone) } : {}),
  } : { name: "Consumidor Final" };

  // A date change must never move money. If the payload we just rebuilt would
  // total something other than what the document already holds, the read-back
  // did not give us the document we think it did — stop.
  //
  // The tolerance is rounding noise, not slack: IX hands `unit_price` back
  // rounded to 2dp while computing its own subtotal in full precision, so a
  // faithful rebuild can land a cent or two off on a multi-line document. What
  // this has to catch is a whole VAT band going missing (3.28€ on a 58€ sale),
  // which is orders of magnitude larger.
  const rebuilt = ixExpectedTotals(items);
  const storedTotal = Number(doc.total);
  const tolerance = 0.02 + 0.01 * items.length;
  if (Number.isFinite(storedTotal) && Math.abs(rebuilt.gross - storedTotal) > tolerance) {
    throw new Error(
      `Reconstrução do documento dá ${rebuilt.gross.toFixed(2)}€ mas o documento tem ${storedTotal.toFixed(2)}€ `
      + `— não altero a data à custa do valor`,
    );
  }

  // A 0% line must name the legal reason it is exempt, and this PUT REPLACES the
  // document — so a reason that does not travel with it is a reason the document
  // no longer has.
  //
  // The old spelling was `doc.tax_exemption ?? (isExempt ? ctx.exemptionReason : null)`,
  // and it is how lliberta's 11/LL came to declare M99. IX read the draft back
  // with `tax_exemption: ""`; `??` keeps an empty string, the truthiness test
  // below then dropped the field, and IX — which does NOT refuse an exempt
  // document with no reason, contrary to what this code assumed — stamped its own
  // default, M99. The observations still print the M10 text to this day, because
  // observations ARE sent verbatim: the sentence survived and the code did not.
  // Same for the Bikini Books and DO IT BRAVELY documents, all of them backfills,
  // because only a date that has to MOVE reaches this rewrite at all.
  //
  // The shop's configured code applies ONLY to a document that is actually
  // exempt. Handing it to a fully taxed document would declare an exemption it
  // does not have — the mirror image of the bug above, and just as wrong.
  const isExemptDocument = items.some((it: any) => Number(it?.tax?.value ?? 0) === 0);
  const storedCode = resolveExemptionCode(doc.tax_exemption, null);
  const exemptionReason = storedCode ?? (isExemptDocument ? resolveExemptionCode(null, ctx.exemptionReason) : null);

  // Refuse rather than restate the document's tax regime. Same posture as the
  // tax rebuild above: leaving a draft un-certified is recoverable, quietly
  // reissuing it under a regime nobody chose is not.
  if (isExemptDocument && !exemptionReason) {
    throw new Error(
      `O documento tem linhas isentas e não sei a razão de isenção `
      + `(nem o documento a devolve, nem a loja tem uma configurada) `
      + `— não reescrevo o documento sem ela, o IX ficaria com M99`,
    );
  }

  return {
    type: ixDocType,
    data: {
      date: targetDate,
      due_date: targetDate,
      client,
      items,
      observations,
      ...(doc.reference ? { reference: String(doc.reference) } : {}),
      ...(exemptionReason ? { tax_exemption_reason: exemptionReason } : {}),
    },
  };
}

/**
 * Per-run state shared across the rows of one finalize batch.
 *
 * `seriesLastFinalizedDate` is deliberately mutable and advances as documents are
 * certified: without it, a bulk run reads the series baseline once, finalizes row
 * one at a later date, and then has IX reject every subsequent row for falling
 * behind a document this very run created.
 */
export interface IxFinalizeBatch {
  readonly kind: "invoicexpress";
  accountTaxes: Map<number, { name: string; value: number }>;
  seriesLastFinalizedDate: string | null;
}

export async function prepareIxFinalizeBatch(
  config: IRequestConfig,
  headers: IxHeaders,
  docKind: IxDocKind,
  strategy: FinalizeDateStrategy,
): Promise<IxFinalizeBatch> {
  // `today` needs no baseline — it never negotiates.
  const seriesLastFinalizedDate = strategy === "today"
    ? null
    : await fetchSeriesLastFinalizedDate(config, docKind);
  return {
    kind: "invoicexpress",
    accountTaxes: await fetchAccountTaxes(headers),
    seriesLastFinalizedDate,
  };
}

/**
 * The dates to try, in order.
 *
 * `closest_available` yields exactly one: the sale's own date, moved forward only
 * far enough to clear the series. It must NOT fall back to today — a bulk run
 * quietly restamping a backlog to the day it happened to be executed is a fiscal
 * misstatement, and an operator who wants today asks for `today`.
 *
 * `series_or_today` adds today as a final rung, for rescuing one stuck document
 * where staying un-certifiable is the worse outcome.
 */
function candidateDates(
  strategy: FinalizeDateStrategy,
  originalDate: string,
  seriesLast: string | null,
  today: string,
): string[] {
  if (strategy === "today") return [today];

  let preferred = originalDate;
  if (seriesLast && seriesLast > preferred) preferred = seriesLast;
  if (strategy === "closest_available") return [preferred];

  return [...new Set(
    [preferred, today].filter((d) => d >= originalDate).sort(),
  )];
}

/**
 * Certify ONE draft, keeping the document as close to the transaction date as
 * InvoiceXpress will accept.
 *
 * Until 2026-08-07 this was a bare `changeState` with `actualizeDateBeforeChange:
 * true`. That flag makes IX push the document's `date` to today while leaving
 * `due_date` on the original order date — and IX then rejects its own result with
 * "Vencimento deve ser igual ou posterior à data do documento". Every draft older
 * than the current day was therefore permanently un-finalizable through this
 * path: five consecutive nightly sweeps finalized nothing while ~275 drafts sat
 * across the fleet.
 */
export async function finalizeIxDraft(
  ctx: AdapterCtx,
  invoiceId: string,
  docKind: IxDocKind,
  headers: IxHeaders,
  doc: any,
  opts: {
    strategy: FinalizeDateStrategy;
    batch: IxFinalizeBatch;
    paidTotal?: number | null;
    dateMovedNote?: (originalDate: string) => string | null;
    dryRun?: boolean;
  },
): Promise<FinalizeOutcome> {
  // Not a draft = nothing to certify. Bulk runs re-walk every processed order in
  // their window, so this is the common case and it is a skip, not an error.
  // `canceled` is called out separately: reporting a voided document as "already
  // finalized" tells an operator the sale is invoiced when it has been undone.
  const state = String(doc.status ?? "").toLowerCase();
  if (state === "canceled" || state === "cancelled") {
    return { status: "skipped", message: "Documento anulado — a venda não está facturada" };
  }
  if (state !== "draft") return { status: "skipped", message: `Already finalized (status=${state})` };

  // Finalizing is irreversible: a wrong document can only be undone with a
  // credit note. A draft whose total is not the amount the customer paid is
  // never certified here — it is the 0%-VAT drafts of 2026-08-02→05 (gross
  // 54.72€ on a 58.00€ sale) that this stops, and any future drift too.
  const paid = opts.paidTotal;
  const docTotal = Number(doc.total);
  if (typeof paid === "number" && Number.isFinite(paid) && paid > 0 && Number.isFinite(docTotal)
    && Math.abs(docTotal - paid) > 0.011) {
    return {
      status: "error",
      message: `Total do documento (${docTotal.toFixed(2)}€) não é o valor pago (${paid.toFixed(2)}€) — não certifico`,
    };
  }

  const originalDate = parseIxDate(doc.date);
  if (!originalDate) return { status: "error", message: `Could not parse draft date '${doc.date}'` };

  const candidates = candidateDates(opts.strategy, originalDate, opts.batch.seriesLastFinalizedDate, todayUtcYmd());
  const existingObs = typeof doc.observations === "string" ? doc.observations.trim() : "";
  let currentDate = originalDate;
  let lastError = "";

  for (const targetDate of candidates) {
    const dateChanged = targetDate !== originalDate;
    const note = dateChanged ? opts.dateMovedNote?.(originalDate) ?? null : null;
    const observations = note
      ? (existingObs ? `${existingObs} | ${note}` : note).slice(0, 200)
      : existingObs;

    if (opts.dryRun) {
      // Advance the baseline so a dry run predicts the same date sequence the
      // real run would produce — otherwise the preview an operator approves is
      // not the run they get.
      opts.batch.seriesLastFinalizedDate = targetDate;
      return {
        status: "dry_run",
        date: targetDate,
        originalDate,
        message: dateChanged
          ? `Would PUT date ${formatPtDate(originalDate)} → ${formatPtDate(targetDate)}${note ? ` and append: "${note}"` : ""}, then finalize`
          : `Would finalize as-is (${formatPtDate(originalDate)})`,
      };
    }

    if (targetDate !== currentDate) {
      let putBody: any;
      try {
        putBody = buildIxDatePutBody(doc, docKind, targetDate, observations, {
          accountTaxes: opts.batch.accountTaxes,
          exemptionReason: ctx.config.ix_exemption_reason ?? null,
        });
      } catch (e: any) {
        // The rebuild refused (unreadable tax, or a payload that would change
        // the money). Leave the draft exactly as it is.
        return { status: "error", message: String(e?.message ?? e) };
      }
      // Under load the proxy answers a well-formed body with a spurious
      // VALIDATION_ERROR — measured on a backlog run: 81 documents rejected for
      // "Tax name must be at least 1 character" whose lines all carried IVA6,
      // and the very same body accepted first try once the run had stopped. So
      // back off and try again rather than writing off a document.
      let putError: unknown = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
        ({ error: putError } = await IxApi.v2.documents.byId.put({
          headers,
          path: { id: Number(invoiceId) },
          body: putBody,
        }));
        if (!putError) break;
      }
      if (putError) {
        return { status: "error", message: `PUT date ${formatPtDate(targetDate)} failed: ${JSON.stringify(putError)}` };
      }
      currentDate = targetDate;
    }

    const { error } = await IxApi.v2.changeState.post({
      headers,
      body: { type: docKind, id: Number(invoiceId), state: "finalized" },
    });
    if (!error) {
      opts.batch.seriesLastFinalizedDate = targetDate;
      return {
        status: "finalized",
        date: targetDate,
        originalDate,
        message: dateChanged
          ? `Finalizada em ${formatPtDate(targetDate)} — o IX recusou a data da transacção (${formatPtDate(originalDate)}), que ficou anotada no documento`
          : `Finalizada com a data da transacção (${formatPtDate(originalDate)})`,
      };
    }
    if (isAlreadyFinalizedIxError(error)) {
      return { status: "skipped", message: "Already finalized (document has payments / cannot be edited)" };
    }
    lastError = `Finalize failed: ${JSON.stringify(error)}`;
    // Anything that is not a date complaint will not be fixed by moving the
    // date, so stop here and leave the draft exactly as we found it.
    if (!isDateRejectionIxError(error)) return { status: "error", message: lastError };
  }

  return { status: "error", message: lastError || "Finalize failed: no acceptable date" };
}
