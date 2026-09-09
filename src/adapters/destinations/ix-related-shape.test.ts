import { describe, it, expect, vi, afterEach } from "vitest";
import { IxApi } from "../../api/ix";
import { ixRelatedDocuments } from "./ix-destination";

/**
 * "Does this document already have a credit note?" — asked before issuing one.
 *
 * Three call sites asked it and read the answer one level too shallow, so every
 * document came back with no credit notes and the guard against crediting twice
 * never fired. Measured live on 2026-09-09: the proxy returned credit note
 * 40/Registo for document 257613395 and `issue-credit-note` still offered to
 * credit it.
 *
 * The shapes nest because the generated client wraps the body: it hands back
 * `{ data: <body> }`, and the body is the proxy's own envelope
 * `{ data: { documents }, success, error }`.
 */

const ENVELOPE = {
  data: {
    documents: [
      { id: 258683426, type: "CreditNote", sequence_number: "40/Registo", status: "settled", total: 29.96, reference: "pyr_1TZvWbHtFLuAcUr8dQ9iMuk5" },
      { id: 111, type: "CreditNote", sequence_number: "9/Registo", status: "canceled", total: 10, reference: "x" },
    ],
  },
  success: true,
  error: null,
  metadata: {},
};

afterEach(() => vi.unstubAllGlobals());

describe("reading the related documents back", () => {
  it("finds them through the generated client, which nests the body one deeper", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify(ENVELOPE), { status: 200, headers: { "content-type": "application/json" } })));

    const res = await IxApi.v2.documents.byId.related.get({
      headers: { "x-account-name": "conta", "x-api-key": "chave", "x-env": "prod" },
      path: { id: 257613395 },
    });

    // The bug, pinned: one level in is undefined, and `?? []` made that look
    // like "no credit notes" rather than "you read the wrong place".
    expect((res as any)?.data?.documents).toBeUndefined();

    const docs = ixRelatedDocuments(res);
    expect(docs).toHaveLength(2);
    expect(docs[0].sequence_number).toBe("40/Registo");
  });

  it("also accepts the bare envelope, which the hand-rolled caller already unwraps", () => {
    expect(ixRelatedDocuments(ENVELOPE)).toHaveLength(2);
  });

  it("answers with an empty list rather than throwing on a shape it does not know", () => {
    expect(ixRelatedDocuments(null)).toEqual([]);
    expect(ixRelatedDocuments({})).toEqual([]);
    expect(ixRelatedDocuments({ data: { data: {} } })).toEqual([]);
  });
});
