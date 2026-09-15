/**
 * `paid` on a document that is already closed does nothing.
 *
 * A card-paid Stripe invoice sends `invoice.paid` after the
 * `payment_intent.succeeded` that already created and finalized its document.
 * The paid branch finalized again, InvoiceXpress refused ("cannot change a
 * InvoiceReceipt in status 'settled'") on all eleven deliveries, and the
 * dead-letter queue told WHM "Encomenda NÃO foi facturada" for two sales that
 * were invoiced (15/09/2026, pi_3UFvliLXiybx6Vcz1667s22k and
 * pi_3UFwnHLXiybx6Vcz1xyyLQRY).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const PI = "pi_3UFvliLXiybx6Vcz1667s22k";
const finalize = vi.fn();
const getDocument = vi.fn();
const emailDocument = vi.fn();
const reportIncident = vi.fn();
const logDocumentEvent = vi.fn();
const saveLog = vi.fn();
const markWebhookAsProcessed = vi.fn();

vi.mock("../adapters/registry", () => ({
  getSourceAdapter: () => ({
    externalId: () => PI,
    toNormalized: async () => ({ order: {} }),
    capabilities: { emitsSeparatePaidEvent: false },
  }),
  getDestinationAdapter: () => ({
    finalize: (...a: any[]) => finalize(...a),
    getDocument: (...a: any[]) => getDocument(...a),
    emailDocument: (...a: any[]) => emailDocument(...a),
  }),
}));
vi.mock("../storage", () => ({
  AppStorage: class {
    claimOrder = async () => true;
    releaseOrderClaim = async () => {};
    isInvoiceAlreadyProcessed = async () => true;
    getInvoiceByOrderId = async () => ({ invoice_id: "270397721", hold_reason: null, routed_json: null });
    markWebhookAsProcessed = (...a: any[]) => markWebhookAsProcessed(...a);
    saveLog = (...a: any[]) => saveLog(...a);
  },
}));
vi.mock("../services/adapter-ctx", () => ({
  buildAdapterCtx: async (_env: any, { config }: any) => ({ ctx: { config: { ...config }, sourceConfig: {} }, tagRoutingRules: [] }),
}));
vi.mock("../services/pause-gate", () => ({ isIntegrationPaused: async () => false }));
vi.mock("../services/subscription-gate", () => ({ checkSubscriptionGate: async () => ({ allowed: true }) }));
vi.mock("../services/run-in", () => ({ runInHoldsFinalize: async () => false }));
vi.mock("../services/incidents", () => ({ reportIncident: (...a: any[]) => reportIncident(...a) }));
vi.mock("../services/document-log", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  logDocumentEvent: (...a: any[]) => logDocumentEvent(...a),
}));

const { runAdapterPipeline } = await import("./generic-pipeline");

const run = () => runAdapterPipeline({
  env: {} as any,
  // Email on, so a second send would show up below.
  config: { user_id: "user_WHM", auto_finalize: 1, ix_send_email: 1 } as any,
  source: "stripe_connect",
  destination: "invoicexpress",
  topic: "paid",
  webhookId: "evt_1UFvr0LXiybx6Vczzly0amVD",
  body: {},
});

beforeEach(() => {
  for (const f of [finalize, getDocument, emailDocument, reportIncident, logDocumentEvent, saveLog, markWebhookAsProcessed]) f.mockReset();
});

describe("paid on a sale whose document exists", () => {
  it("acks a finalized document without finalizing, logging or emailing again", async () => {
    getDocument.mockResolvedValue({ id: "270397721", state: "finalized", number: "FR 2026/952" });

    await run();

    expect(finalize).not.toHaveBeenCalled();
    expect(emailDocument).not.toHaveBeenCalled();
    expect(logDocumentEvent).not.toHaveBeenCalled();
    expect(reportIncident).not.toHaveBeenCalled();
    expect(markWebhookAsProcessed).toHaveBeenCalledWith("evt_1UFvr0LXiybx6Vczzly0amVD", "stripe_connect/paid", "success");
    expect(saveLog.mock.calls.at(-1)![0]).toMatchObject({ response: "Already finalized", status: 200 });
  });

  it("does not take a document with no number as closed", async () => {
    // InvoiceXpress reads a missing or unknown status as final; the number is
    // the positive evidence that a close happened.
    getDocument.mockResolvedValue({ id: "270397721", state: "finalized", number: null });
    finalize.mockResolvedValue(undefined);

    await run();

    expect(finalize).toHaveBeenCalledWith("270397721", expect.anything());
  });

  it("still finalizes a draft, and a refusal still surfaces", async () => {
    getDocument.mockResolvedValue({ id: "270397721", state: "draft" });
    finalize.mockRejectedValue(new Error("InvoiceXpress finalize failed: {\"code\":\"UNKNOWN\"}"));

    await expect(run()).rejects.toThrow("InvoiceXpress finalize failed");
    expect(finalize).toHaveBeenCalledWith("270397721", expect.anything());
    expect(reportIncident).toHaveBeenCalledTimes(1);
  });
});
