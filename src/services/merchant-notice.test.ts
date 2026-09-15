import { describe, it, expect } from "vitest";
import { renderMerchantActionNeeded, bucketKeyFor } from "./incidents";
import { renderIncidentTemplate } from "./email-templates";

// The wording of the shop owner's notice is the deliverable here, so it is
// asserted rather than eyeballed. Two kinds share this message and must not
// blur together: `nif_invalid_draft` (document exists, as a draft) and
// `nif_invalid` (nothing was issued at all).

const draftInput: any = {
  user_id: "u1",
  severity: "warning",
  kind: "nif_invalid_draft",
  summary: "…",
  order_ref: "#4692",
  client_name: "Ana Silva",
  detail: {
    invoiceId: "266153290",
    raw: "500000001",
    field: "shipping.address2",
    permalink: "https://web.invoicexpress.com/documents/266153290abc",
  },
};

describe("merchant notice — invoice left as a draft", () => {
  it("names the invoice, the order and why, as asked", () => {
    const { subject, html } = renderMerchantActionNeeded(draftInput);
    expect(subject).toBe("Factura de #4692 ficou em rascunho (NIF inválido)");
    expect(html).toContain("266153290");   // a factura X
    expect(html).toContain("#4692");        // referente à encomenda Y
    expect(html).toContain("ficou em rascunho.");
    expect(html).toContain("500000001");    // the offending value, quoted back
    expect(html).toContain("Ana Silva");
  });

  it("links the draft when a permalink is known", () => {
    const { html } = renderMerchantActionNeeded(draftInput);
    expect(html).toContain("https://web.invoicexpress.com/documents/266153290abc");
    expect(html).toContain("Ver rascunho");
  });

  it("omits the button when no permalink was resolved", () => {
    const { html } = renderMerchantActionNeeded({ ...draftInput, detail: { ...draftInput.detail, permalink: null } });
    expect(html).not.toContain("Ver rascunho");
  });

  it("tells the merchant the customer got nothing and the AT was not told", () => {
    const { html } = renderMerchantActionNeeded(draftInput);
    expect(html).toContain("Nada foi comunicado à AT");
    expect(html).toContain("o cliente não recebeu nada");
  });

  it("keeps the old 'not invoiced at all' wording for nif_invalid", () => {
    const { subject, html } = renderMerchantActionNeeded({ ...draftInput, kind: "nif_invalid" });
    expect(subject).toBe("Ação necessária: #4692 não foi faturada (NIF inválido)");
    expect(html).toContain("não foi faturada.");
    expect(html).not.toContain("ficou em rascunho.");
  });

  it("survives an incident with no order ref, invoice id or client", () => {
    const { subject, html } = renderMerchantActionNeeded({ user_id: "u1", severity: "warning", kind: "nif_invalid_draft", summary: "…" } as any);
    expect(subject).toBe("Uma factura ficou em rascunho (NIF inválido)");
    expect(html).toContain("A factura ficou em rascunho.");
  });
});

describe("incident dedup bucket", () => {
  const at = (iso: string) => new Date(iso);
  const held = (invoiceId: string): any => ({ user_id: "u1", kind: "nif_invalid_draft", dedup_key: invoiceId, severity: "warning", summary: "" });

  it("gives each held document its own bucket so every one is reported", () => {
    // The merchant notice only fires on a bucket's FIRST occurrence. Sharing a
    // bucket meant the second invoice held in the same hour was never reported
    // — one email, two stuck drafts.
    const a = bucketKeyFor(held("266153290"), at("2026-08-06T14:05:00Z"));
    const b = bucketKeyFor(held("266153999"), at("2026-08-06T14:47:00Z"));
    expect(a).not.toBe(b);
  });

  it("still swallows a re-delivered webhook for the same document", () => {
    const a = bucketKeyFor(held("266153290"), at("2026-08-06T14:05:00Z"));
    const b = bucketKeyFor(held("266153290"), at("2026-08-06T14:47:00Z"));
    expect(a).toBe(b);
  });

  it("leaves outage-shaped kinds on the shared hourly bucket", () => {
    // 200 orders failing on one expired token must stay one email.
    const base: any = { user_id: "u1", kind: "auth_failure_destination", severity: "critical", summary: "" };
    expect(bucketKeyFor(base, at("2026-08-06T14:05:00Z")))
      .toBe(bucketKeyFor(base, at("2026-08-06T14:47:00Z")));
  });

  it("separates two integrations of the same account", () => {
    // One account, two integrations, both failing in the same hour. Sharing a
    // bucket made them ONE incident: occurrences went to 2, the summary was
    // overwritten by whichever landed second, and `notified_at` was already set
    // so no second email went out. The merchant heard about one pipe and never
    // about the other — and the alert they did read named the wrong one.
    const failing = (label: string): any => ({
      user_id: "u1", kind: "destination_reject", severity: "critical",
      summary: "", connection_label: label,
    });
    expect(bucketKeyFor(failing("stripe → invoicexpress"), at("2026-08-06T14:05:00Z")))
      .not.toBe(bucketKeyFor(failing("stripe_connect → moloni"), at("2026-08-06T14:20:00Z")));
  });

  it("still groups an outage within ONE integration", () => {
    const same = (): any => ({
      user_id: "u1", kind: "auth_failure_destination", severity: "critical",
      summary: "", connection_label: "stripe_connect → moloni",
    });
    expect(bucketKeyFor(same(), at("2026-08-06T14:05:00Z")))
      .toBe(bucketKeyFor(same(), at("2026-08-06T14:47:00Z")));
  });

  it("treats the two spellings of one connection as one bucket", () => {
    // Most callers pass the raw identifiers; a handful go through
    // `connectionLabelOf`, which prettifies. `queue_retry_exhausted` is critical
    // and is reported from several places in BOTH spellings — keyed as written,
    // one Stripe failure reaching two of them would raise two alerts.
    const failing = (label: string): any => ({
      user_id: "u1", kind: "queue_retry_exhausted", severity: "critical",
      summary: "", connection_label: label,
    });
    expect(bucketKeyFor(failing("stripe → invoicexpress"), at("2026-08-06T14:05:00Z")))
      .toBe(bucketKeyFor(failing("Stripe → InvoiceXpress"), at("2026-08-06T14:20:00Z")));
  });

  it("groups exactly as before when no connection is named", () => {
    // Most callers pass no label, and their buckets must not move: a regrouping
    // here would re-open incidents a merchant has already been emailed about.
    const base: any = { user_id: "u1", kind: "auth_failure_destination", severity: "critical", summary: "" };
    expect(bucketKeyFor(base, at("2026-08-06T14:05:00Z"))).toBe("u1:auth_failure_destination:2026-08-06T14");
  });
});

describe("refund on a draft", () => {
  it("explains that a credit note only corrects a finalized document", () => {
    const tpl = renderIncidentTemplate("credit_note_on_draft", {
      occurrences: 1,
      firstSeenAt: "2026-08-06T10:00:00Z",
      lastSeenAt: "2026-08-06T10:00:00Z",
      summary: "Reembolso na encomenda #4692 não gerou nota de crédito.",
      orderRef: "#4692",
      detail: { invoiceId: "266153290", status: "draft" },
    });
    expect(tpl.subject).toContain("rascunho");
    expect(tpl.html).toContain("266153290");
    expect(tpl.html).toContain("apagá-lo");
    expect(tpl.html).toContain("#4692");
  });
});

describe("incident template for the digest / preview route", () => {
  it("renders the new kind instead of falling through to undefined", () => {
    const tpl = renderIncidentTemplate("nif_invalid_draft", {
      occurrences: 1,
      firstSeenAt: "2026-08-06T10:00:00Z",
      lastSeenAt: "2026-08-06T10:00:00Z",
      summary: "A factura 266153290 ficou em rascunho.",
      orderRef: "#4692",
      detail: { raw: "500000001", field: "shipping.address2", permalink: "https://web.invoicexpress.com/d/1" },
    });
    expect(tpl.subject).toContain("rascunho");
    expect(tpl.html).toContain("500000001");
    expect(tpl.html).toContain("shipping.address2");
    expect(tpl.html.length).toBeGreaterThan(1000);
  });
});
