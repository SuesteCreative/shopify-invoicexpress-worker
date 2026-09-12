import type { Env } from "../env";
import type { AdapterCtx, DestinationAdapter } from "../adapters/types";
import { EU_COUNTRIES } from "../ix/eu-countries";
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
  /**
   * For historical documents, where the exact code we sent was never recorded:
   * the set the shop is configured to be able to use. A stored code inside the
   * set is not evidence of anything; only one OUTSIDE it is.
   *
   * The single-value check is wrong for history because the code is not purely
   * a shop setting — `detectShopifyReverseCharge` reads the ORDER's
   * `customer.tax_exemptions`, so a B2B EU sale legitimately carries the
   * connection's `ix_b2b_exemption_reason` instead of its generic one. Comparing
   * against the generic code alone flagged eight perfectly correct Angel
   * Piercing documents as drifted.
   */
  acceptableExemptionCodes?: string[] | null;
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

  // The permissive form, used when the exact code we sent was not recorded and
  // several are legitimate. Silence unless the destination holds one the shop
  // could not have asked for.
  const acceptable = (intent.acceptableExemptionCodes ?? []).filter(Boolean);
  if (acceptable.length > 0 && stored.exemption_code != null && !acceptable.includes(stored.exemption_code)) {
    drifts.push({
      field: "exemption_code",
      sent: acceptable.join(" ou "),
      stored: stored.exemption_code,
      meaning:
        `O código de isenção é o que segue no SAF-T para a AT. O documento declara `
        + `${stored.exemption_code}, que não é nenhum dos códigos configurados para esta loja `
        + `(${acceptable.join(", ")}) — logo não pode ter saído da configuração dela.`,
    });
  }

  // Only when we actually sent one: a document with no exemption is not a drift.
  if (acceptable.length === 0 && intent.exemptionCode && stored.exemption_code != null && intent.exemptionCode !== stored.exemption_code) {
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

/**
 * Codes that assert something about the BUYER, and what contradicts each.
 *
 * This is the whole precision of the check, so it is deliberately tiny.
 *
 * An exemption code is a claim, and claims come in two kinds. `M07` (art. 9.º),
 * `M10` (art. 53.º), `M01`, `M99` say something about the SELLER — they are true
 * whatever the buyer does, and a shop legitimately on one of them would be
 * warned about every sale it ever makes. Eleven of the thirteen live connections
 * are exactly that, so a check that did not draw this line would be a phantom
 * generator, which is the failure mode this fleet has been burned by more than
 * any other. Seller-side codes are therefore never examined.
 *
 * `M16` / `M40` / a shop's own `ix_b2b_exemption_reason` say the buyer is a
 * taxable person in another member state. That is a claim about the buyer's
 * IDENTITY, and the document carries the facts to test it: a country and a tax
 * id. `M05` (export) is deliberately absent — it is a claim about where the
 * goods WENT, and no destination hands that back. See the note at the M05 site.
 *
 * What is NOT asserted, on purpose: that M40 on a non-EU buyer is wrong. The
 * repo contradicts itself there — `ossExemptionCode` (adapters/tax-rates.ts)
 * stamps M40 on a zero-rated non-EU sale by default, while
 * scripts/audit-tax-params.mjs reports that same pairing as a finding. Both can
 * be right: M05 is art. 14.º CIVA (export of GOODS), M40 is art. 6.º n.º 6 a)
 * (SERVICES to a taxable person outside PT, EU or not). Which applies depends on
 * what the merchant sells, and that is an accountant's call, not a sweep's.
 */
const BUYER_CLAIMING_CODES = new Set(["M16", "M40"]);

/**
 * The EU-27 as InvoiceXpress spells them, derived from the same ISO list the
 * invoicing path uses so the two cannot drift apart.
 *
 * IX stores a client's country by NAME ("France"), not as an ISO2 code —
 * `toIxCountryName` (ix/builder.ts) converts on the way in and there is no
 * inverse. Comparing `EU_COUNTRIES.has("France")` is therefore always false, and
 * the M05 rule would have been dead on arrival without this: silent, passing its
 * tests, and finding nothing for ever.
 */
function euCountryNames(): Set<string> {
  const names = new Set<string>();
  for (const cc of EU_COUNTRIES) {
    names.add(cc.toLowerCase());
    try {
      const n = new Intl.DisplayNames(["en"], { type: "region" }).of(cc);
      if (n) names.add(n.toLowerCase());
    } catch {
      // Intl unavailable: the ISO2 forms above still work. Never throw from a
      // verifier — see property 1 at the top of this file.
    }
  }
  // IX's own spelling of CZ, which Intl renders as "Czechia". Both are the same
  // member state and both appear in the fleet's documents.
  names.add("czech republic");
  return names;
}

const EU_COUNTRY_NAMES = euCountryNames();

/**
 * Does the document's own exemption code contradict the buyer it was issued to?
 *
 * Pure, and separate from `compareIntent` because it answers a different
 * question. `compareIntent` asks "did the destination store what we sent"; a
 * wrong regime stored faithfully passes that check for ever. This asks whether
 * what we sent was a claim the document itself disproves.
 *
 * Measured on WHM, 09/09/2026: eight documents, every one 0 % with M40 —
 * "autoliquidação, serviços a sujeito passivo de outro Estado-membro" — issued
 * to private consumers with no VAT number anywhere (zero `tax_ids` across 403
 * Stripe payments that year). Nobody chose that code per sale: the rate engine
 * was unregistered, so nothing decided, and `shouldRequestTaxExemptionReason`
 * stamped the connection's global code because IX demands one for any zero line.
 * The exemption was what was left when nothing decided, and no counter, log or
 * incident said a word.
 *
 * Every branch fails CLOSED — an absent fact yields no finding, never a finding.
 */
export function checkRegimeClaim(stored: {
  exemption_code?: string | null;
  buyer_country?: string | null;
  buyer_tax_id?: string | null;
}): FieldDrift[] {
  const code = String(stored.exemption_code ?? "").trim().toUpperCase();
  // No code means no claim: a fully-taxed document asserts nothing to contradict.
  if (!code || !BUYER_CLAIMING_CODES.has(code)) return [];

  const drifts: FieldDrift[] = [];

  const countryRaw = String(stored.buyer_country ?? "").trim();
  const inEu = countryRaw ? EU_COUNTRY_NAMES.has(countryRaw.toLowerCase()) : null;

  // M16/M40 assert a taxable person IN ANOTHER MEMBER STATE. Two facts have to
  // fail together before this is a contradiction, and requiring both is what
  // keeps it honest:
  //
  //   - no tax id on the document. `null` is "the destination did not tell us"
  //     and is not evidence of absence — only "" is.
  //   - the buyer is in the EU. Outside it, whether M40 is the right code is
  //     genuinely contested: `ossExemptionCode` (adapters/tax-rates.ts) stamps
  //     M40 on a zero-rated non-EU sale by default, and a merchant selling
  //     SERVICES may be right to (art. 6.º n.º 6 al. a) is not limited to the
  //     EU), while audit-tax-params.mjs reports the same pairing as a finding
  //     because for GOODS it should be M05. Not a sweep's call.
  //
  // Measured before this second condition existed: the check fired on all eight
  // WHM documents, seven of which are US/CH/GT/KH/AZ/AE/UK — sales the merchant
  // has deliberately decided to invoice under M40. One true finding and seven
  // arguments is how a useful signal gets switched off.
  if ((code === "M16" || code === "M40") && stored.buyer_tax_id === "" && inEu === true) {
    drifts.push({
      field: "exemption_code",
      sent: code,
      stored: `cliente em ${countryRaw}, sem NIF`,
      meaning:
        `${code} declara autoliquidação por o comprador ser um sujeito passivo de outro Estado-membro, `
        + `mas o documento não traz número de IVA nenhum e o comprador está na UE (${countryRaw}). `
        + `Ou é um particular — e então a venda não é autoliquidação, é uma venda à distância que tributa `
        + `no país dele — ou o número existe e não chegou ao documento. `
        + `Confirmar antes de finalizar: num documento fechado a menção é uma declaração à AT.`,
    });
  }

  // M05 is art. 14.º CIVA — the sale left the EU. A buyer inside it did not.
  // M05 (art. 14.º CIVA, export) is deliberately NOT checked here, and this is
  // the second thing a live dry run caught.
  //
  // Export is about where the goods WENT. The only country on a destination
  // document is the client's, which is the BILLING address (buildInvoiceClient
  // prefers billing; see rioko-invoice-address-priority). A Portuguese customer
  // shipping to Brazil is a legitimate M05 export whose client record says
  // "Portugal" — so judging export from this field marks correct documents as
  // wrong. Measured 12/09/2026: 4 of 15 sampled Angel Piercings documents and 3
  // of 15 Bikini Books ones, none of them provably wrong.
  //
  // scripts/audit-tax-params.mjs already answers this question properly, from
  // the ORDER's `shipping_address.country_code ?? billing_address.country_code`
  // (:127), and reports it as CODIGO NAO COBRE O DESTINO.
  //
  // ponytail: a billing-only fact cannot decide a destination-based regime.
  // Upgrade path is a `buyer_shipping_country` on DestinationDocument, the day
  // a destination hands one back — InvoiceXpress does not.

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
  /**
   * History mode: the comparison ran against TODAY's configuration, not a
   * recorded intent, so a mismatch is a lead to confirm rather than a verdict.
   * Writes `drift_lead` (info, routine retention) and raises no incident.
   */
  historical?: boolean;
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

  // The regime claim is logged SEPARATELY from the drifts above, and always as a
  // lead, because it is a different kind of statement.
  //
  // A drift says "the destination holds something other than what we sent" — a
  // verdict, provable from two recorded values. A regime finding says "the code
  // on this document does not fit the buyer on it", which is read off today's
  // document against today's rules. That is the literal definition of
  // `drift_lead` ("a mismatch against today's configuration — a lead, not a
  // verdict"), so it stays info-severity, raises no incident and sends the
  // merchant nothing. Folding it into `drifts` would have promoted it to `drift`
  // on the nightly sweep — which runs with `history: false` — and turned a
  // question for an accountant into a 04:00 alert.
  //
  // Kept out of the returned `drifts` for the same reason: the caller counts
  // those as drifted documents.
  try {
    const regime = checkRegimeClaim(stored);
    if (regime.length > 0) {
      await logDocumentEvent(env, {
        ...base,
        event: "drift_lead",
        // One lead per document, ever. The sweep already excludes anything with
        // a verdict row, but a re-verified document must not stack duplicates.
        dedupKey: `regime_lead:${invoiceId}`,
        summary:
          `Documento ${docName} da venda ${label}: ${regime.map(d => d.meaning).join(" ")} `
          + `É uma pista, não um veredicto — o regime depende do que a loja vende e de quem é o comprador. `
          + `Confirmar com a contabilidade antes de mexer no documento.`,
        detail: {
          invoiceId,
          state: stored.state,
          kind: "regime_claim",
          exemption_code: stored.exemption_code ?? null,
          buyer_country: stored.buyer_country ?? null,
          buyer_has_tax_id: stored.buyer_tax_id ? true : stored.buyer_tax_id === "" ? false : null,
          findings: regime,
          unconfirmed: true,
        },
      });
    }
  } catch (e: any) {
    // Never let the regime check cost a verification. The document exists and is
    // correct-or-not regardless of what this found — property 1 at the top.
    console.warn(`[DocumentVerify] regime check failed for ${invoiceId}: ${String(e?.message ?? e).slice(0, 200)}`);
  }

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

  // A historical finding is NOT proof of a fault: the acceptable set was built
  // from today's configuration, and configuration changes over time — Bikini
  // Books' documents predating its M01→M05 change would read as "drifted" for
  // ever under the strict event. The lead is written so it is not re-found every
  // run, but it stays info-severity and raises no incident until a person
  // confirms it against the document's own day.
  if (args.historical) {
    const leadLines = drifts.map(d => `${d.field}: a configuração de hoje permite ${d.sent}, o documento declara ${d.stored}`).join(" · ");
    await logDocumentEvent(env, {
      ...base,
      event: "drift_lead",
      dedupKey: `drift_lead:${invoiceId}`,
      summary:
        `Documento ${docName} da venda ${label} difere da configuração ACTUAL da loja — ${leadLines}. `
        + `É uma pista, não um veredicto: a configuração pode ter sido outra no dia da emissão. `
        + `Confirmar documento a documento antes de agir.`,
      detail: { invoiceId, state: stored.state, number: stored.number, drifts, unconfirmed: true },
    });
    return { checked: true, drifts };
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
