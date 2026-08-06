import { describe, it, expect, vi, beforeEach } from "vitest";

// The two gates under test are fiscal-safety rules, so they are worth pinning:
// a draft is not a legal document and must never reach the buyer, and a document
// parked for a human must not be sent while it is parked.

const getDoc = vi.fn();
const postEmail = vi.fn();

vi.mock("../api/ix", () => ({
  IxApi: {
    v2: {
      documents: {
        byId: {
          get: (...args: any[]) => getDoc(...args),
          email: { post: (...args: any[]) => postEmail(...args) },
          link: { get: vi.fn() },
        },
      },
    },
  },
}));

// ixCall is a timeout/retry wrapper; for these tests it is just "call it".
vi.mock("../ix/ix-call", () => ({ ixCall: (fn: () => Promise<any>) => fn() }));

const { sendIxDocumentEmail } = await import("./ix-document-email");

const cfg = (over: Record<string, any> = {}): any => ({
  ix_send_email: 1,
  ix_account_name: "acct",
  ix_api_key: "key",
  ix_environment: "production",
  ix_document_type: "invoice_receipt",
  ...over,
});

const doc = (over: Record<string, any> = {}) => ({
  data: { data: { id: 1, status: "sent", permalink: "https://ix/doc/1", client: { email: "buyer@example.com" }, ...over } },
  error: null,
});

beforeEach(() => {
  getDoc.mockReset();
  postEmail.mockReset();
  postEmail.mockResolvedValue({ error: null });
});

describe("sendIxDocumentEmail", () => {
  it("sends a finalized document and returns its quicklink", async () => {
    getDoc.mockResolvedValue(doc());
    const r = await sendIxDocumentEmail(cfg(), 1);
    expect(r).toEqual({ sent: true, recipient: "buyer@example.com", permalink: "https://ix/doc/1" });
    expect(postEmail).toHaveBeenCalledOnce();
  });

  it("never emails a draft", async () => {
    getDoc.mockResolvedValue(doc({ status: "draft" }));
    const r = await sendIxDocumentEmail(cfg(), 1);
    expect(r).toMatchObject({ sent: false, reason: "draft" });
    expect(postEmail).not.toHaveBeenCalled();
  });

  it("never emails a document held for a human, and does not even look it up", async () => {
    const r = await sendIxDocumentEmail(cfg(), 1, { holdReason: 'nif_invalid: "500000001" em billing.address2' });
    expect(r).toMatchObject({ sent: false, reason: "held" });
    expect(getDoc).not.toHaveBeenCalled();
    expect(postEmail).not.toHaveBeenCalled();
  });

  it("stays off unless the merchant opted in", async () => {
    for (const v of [0, null, undefined]) {
      const r = await sendIxDocumentEmail(cfg({ ix_send_email: v }), 1);
      expect(r).toMatchObject({ sent: false, reason: "disabled" });
    }
    expect(getDoc).not.toHaveBeenCalled();
  });

  it("sends to a Consumidor Final buyer — a missing fiscal_id is not a reason to withhold", async () => {
    getDoc.mockResolvedValue(doc({ client: { email: "buyer@example.com" } }));
    const r = await sendIxDocumentEmail(cfg(), 1);
    expect(r).toMatchObject({ sent: true });
  });

  it("reports a failed send instead of throwing", async () => {
    getDoc.mockResolvedValue(doc());
    postEmail.mockResolvedValue({ error: { message: "mailbox unavailable" } });
    const r = await sendIxDocumentEmail(cfg(), 1);
    expect(r).toMatchObject({ sent: false, reason: "send_failed" });
  });

  it("skips a document with no address on the client", async () => {
    getDoc.mockResolvedValue(doc({ client: { email: "" } }));
    const r = await sendIxDocumentEmail(cfg(), 1);
    expect(r).toMatchObject({ sent: false, reason: "no_recipient" });
  });
});
