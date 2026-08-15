import type { Env } from "../env";
import type { AdapterCtx, DestinationAdapter } from "../adapters/types";
import { logDocumentEvent } from "./document-log";
import { reportIncident } from "./incidents";

/**
 * Did the destination store what we sent it?
 *
 * Nothing in this pipeline asked that question until now, and twice in two days
 * the answer was no while every counter read healthy:
 *
 *   - Stripe sales were all documented as reference "Order #0", so the second
 *     one onwards was discarded as a duplicate of the first. Found by a merchant
 *     counting their own invoices, two days late, 3.278,95 € unbilled.
 *   - lliberta 11/LL was sent with exemption code M10 and InvoiceXpress stored
 *     M99 — on a document whose own observations still render the M10 text.
 *     Found by accident, while auditing something else.
 *
 * Both are invisible to the creating call, which returned success in each case.
 * The only way to see them is to read the document back and compare. This does
 * exactly that, on every document, and writes the result — match INCLUDED — to
 * the document log.
 *
 * Three properties it must keep:
 *
 *   1. **It never fails an invoice.** The document already exists and is
 *      correct-or-not regardless of what this finds; throwing here would turn a
 *      cosmetic doubt into a lost sale. Everything is wrapped.
 *   2. **A failed read is not a drift.** The proxy in front of InvoiceXpress
 *      collapses under load, and treating "could not read" as "does not match"
 *      would page about an outage in the reader, not a fault in the document.
 *   3. **It is ops-only.** `document_drift` is deliberately absent from
 *      MERCHANT_ACTIONABLE_KINDS: the merchant cannot act on the difference
 *      between our payload and the destination's storage, and telling them
 *      erodes trust in a document that is usually fine.
 */

export interface DocumentIntent {
  /** Gross total we intended the document to carry. */
  total?: number | null;
  /** The reference we asked the destination to stamp. */
  reference?: string | null;
  /** The VAT-exemption (SAF-T "M") code we sent, if any. */
  exemptionCode?: string | null;
}

export interface FieldDrift {
  field: "total" | "reference" | "exemption_code";
  sent: string;
  stored: string;
  /** One sentence, in Portuguese, on what this particular difference means. */
  meaning: string;
}

export interface VerifyOutcome {
  checked: boolean;
  drifts: FieldDrift[];
  /** Why the check could not run, when `checked` is false. */
  unreadable?: string;
}

const money = (n: number) => `${n.toFixed(2)} €`;

/**
 * Compare intent against what the destination holds. Pure, so the comparison
 * rules are testable without a destination.
 */
export function compareIntent(
  intent: DocumentIntent,
  stored: { total: number | null; reference: string | null; exemption_code?: string | null },
): FieldDrift[] {
  const drifts: FieldDrift[] = [];

  // A cent of tolerance, matching the reconcile guard: the destination rounds
  // its own way and a half-cent is not a defect.
  //
  // Compared in whole cents on purpose. `Math.abs(100.01 - 100) > 0.01` is TRUE
  // in binary floating point (the difference lands on 0.010000000000005), so the
  // obvious spelling of "tolerate one cent" reports a drift on an exact
  // one-cent difference. Rounding to cents first makes the boundary mean what it
  // says.
  const cents = (n: number) => Math.round(n * 100);
  // `Number.isFinite`, not `!= null`. A caller that could not resolve a total
  // passes NaN, and `NaN != null` is TRUE — so the comparison below ran on NaN,
  // `NaN > 1` is false, and an unreadable total reported as "no drift". Silence
  // dressed as agreement is the exact failure this whole file exists to end.
  if (Number.isFinite(intent.total as number) && stored.total != null
      && Math.abs(cents(intent.total as number) - cents(stored.total)) > 1) {
    drifts.push({
      field: "total",
      sent: money(intent.total as number),
      stored: money(stored.total),
      meaning:
        `O documento no destino não vale o que a venda valia. É a divergência mais grave desta lista: `
        + `o cliente pagou um valor e o documento fiscal declara outro.`,
    });
  }

  if (intent.reference && stored.reference != null && intent.reference !== stored.reference) {
    drifts.push({
      field: "reference",
      sent: intent.reference,
      stored: stored.reference,
      meaning:
        `A referência é a única chave de idempotência entre nós e o destino — é por ela que se pergunta `
        + `"já emitiste este documento?". Guardada diferente da enviada, a pergunta passa a devolver a `
        + `resposta errada, e daí saem faturas em falta ou duplicadas.`,
    });
  }

  // Only when we actually sent one: a document with no exemption is not a drift.
  if (intent.exemptionCode && stored.exemption_code != null && intent.exemptionCode !== stored.exemption_code) {
    drifts.push({
      field: "exemption_code",
      sent: intent.exemptionCode,
      stored: stored.exemption_code,
      meaning:
        `O código de isenção é o que segue no SAF-T para a AT. Enviámos ${intent.exemptionCode} e ficou `
        + `${stored.exemption_code}, o que declara um regime diferente do da loja. O texto legal impresso `
        + `no documento pode estar correcto e o código não — foi o caso da lliberta 11/LL.`,
    });
  }

  return drifts;
}

export interface VerifyArgs {
  env: Env;
  adapter: DestinationAdapter;
  ctx: AdapterCtx;
  invoiceId: string;
  intent: DocumentIntent;
  externalId: string | number;
  userId?: string | null;
  shopifyDomain?: string | null;
  sourceKind?: string | null;
  destinationKind?: string | null;
  actor?: string | null;
  /** For the incident summary: "#1013", "pi_3U4H6U…". */
  orderRef?: string | null;
}

/**
 * Read the document back, compare, and record the result. Returns the outcome
 * for callers that want it; swallows everything else.
 */
export async function verifyCreatedDocument(args: VerifyArgs): Promise<VerifyOutcome> {
  const { env, adapter, ctx, invoiceId, intent, externalId } = args;
  const base = {
    externalId,
    userId: args.userId ?? null,
    shopifyDomain: args.shopifyDomain ?? null,
    sourceKind: args.sourceKind ?? null,
    destinationKind: args.destinationKind ?? null,
    invoiceId,
    actor: args.actor ?? "pipeline",
  };

  if (!adapter.getDocument) {
    return { checked: false, drifts: [], unreadable: "destino não sabe reler documentos" };
  }

  let stored;
  try {
    stored = await adapter.getDocument(invoiceId, ctx);
  } catch (e: any) {
    const why = String(e?.message ?? e).slice(0, 300);
    await logDocumentEvent(env, {
      ...base,
      event: "verify_failed",
      // One per document per day. The sweep re-selects anything without a
      // verified/drift row, so a document the destination will never hand back
      // would otherwise write a row every night for ever.
      dedupKey: `verify_failed:${invoiceId}:${new Date().toISOString().slice(0, 10)}`,
      summary: `Não foi possível reler o documento ${invoiceId} no destino para o conferir (${why}). Não é sinal de problema no documento — é o leitor que não respondeu.`,
      detail: { invoiceId, error: why },
    });
    return { checked: false, drifts: [], unreadable: why };
  }

  if (!stored) {
    await logDocumentEvent(env, {
      ...base,
      event: "verify_failed",
      dedupKey: `verify_failed:${invoiceId}:${new Date().toISOString().slice(0, 10)}`,
      summary: `O destino não devolveu o documento ${invoiceId} ao ser relido. Pode ser atraso de indexação logo após a criação.`,
      detail: { invoiceId },
    });
    return { checked: false, drifts: [], unreadable: "documento não devolvido" };
  }

  const drifts = compareIntent(intent, {
    total: stored.total,
    reference: stored.reference,
    exemption_code: stored.exemption_code ?? null,
  });

  const label = args.orderRef ?? String(externalId);
  const docName = stored.number ?? invoiceId;

  if (drifts.length === 0) {
    await logDocumentEvent(env, {
      ...base,
      event: "verified",
      // At most once per document: the sweep may see it again after a failed
      // read, and one confirmation is the whole truth.
      dedupKey: `verified:${invoiceId}`,
      summary:
        `Documento ${docName} conferido no destino: total, referência e código de isenção iguais aos enviados.`,
      detail: {
        invoiceId,
        checked: { total: intent.total ?? null, reference: intent.reference ?? null, exemption_code: intent.exemptionCode ?? null },
        state: stored.state,
      },
    });
    return { checked: true, drifts: [] };
  }

  const lines = drifts.map(d => `${d.field}: enviámos ${d.sent}, ficou ${d.stored}`).join(" · ");
  await logDocumentEvent(env, {
    ...base,
    event: "drift",
    dedupKey: `drift:${invoiceId}`,
    summary:
      `Documento ${docName} da venda ${label} ficou diferente do que enviámos — ${lines}. `
      + drifts.map(d => d.meaning).join(" "),
    detail: { invoiceId, state: stored.state, number: stored.number, drifts },
  });

  // Ops-only by construction: `document_drift` is not in MERCHANT_ACTIONABLE_KINDS,
  // so this lands in the incidents table and the ops digest and never emails the
  // merchant. Bucketed per document so two drifts in an hour are two incidents.
  try {
    await reportIncident(env, {
      user_id: args.userId ?? null,
      severity: drifts.some(d => d.field === "total") ? "critical" : "error",
      kind: "document_drift",
      dedup_key: `${invoiceId}`,
      summary: `${docName} (${label}): ${lines}`.slice(0, 500),
      detail: { invoiceId, externalId: String(externalId), destination: args.destinationKind, drifts },
      affected_ids: [String(externalId)],
      connection_label: `${args.sourceKind ?? "?"} → ${args.destinationKind ?? "?"}`,
      order_ref: args.orderRef ?? undefined,
    });
  } catch (e: any) {
    console.error(`[DocVerify] incident failed for ${invoiceId}: ${e?.message ?? e}`);
  }

  return { checked: true, drifts };
}
