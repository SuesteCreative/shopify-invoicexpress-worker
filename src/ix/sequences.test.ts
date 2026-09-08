/**
 * The series lookup, now shared by the adapter pipeline and the legacy
 * Shopify→IX handlers.
 *
 * Every test uses its own account name: the module caches sequences per
 * account for the isolate's lifetime, which is deliberate (the list changes
 * rarely) and would otherwise leak between cases.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveIxSequenceId } from "./sequences";

const SERIES = [
  { id: 6211961, serie: "FR2026", current_invoice_sequence_id: 6211961, current_invoice_receipt_sequence_id: 6211963, current_credit_note_sequence_id: 6211968 },
  { id: 6476362, serie: "B2B2026", current_invoice_sequence_id: 6476362, current_invoice_receipt_sequence_id: 6476364, current_credit_note_sequence_id: 6476369 },
];

function stubFetch(body: unknown, ok = true) {
  const fetchMock = vi.fn().mockResolvedValue({ ok, json: async () => body } as any);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const config = (account: string) => ({
  ix_account_name: account,
  ix_api_key: "secret-key",
  ix_environment: "production",
});

afterEach(() => vi.unstubAllGlobals());

describe("resolveIxSequenceId", () => {
  it("asks the account host that actually exists", async () => {
    const fetchMock = stubFetch({ sequences: SERIES });
    await resolveIxSequenceId(config("acct-host"), "FR2026", "invoice_receipt");
    expect(String(fetchMock.mock.calls[0][0])).toContain("https://acct-host.app.invoicexpress.com/sequences.json");
  });

  it("returns the id for THIS document type, not the series' top-level id", async () => {
    stubFetch({ sequences: SERIES });
    const cfg = config("acct-doctype");
    expect(await resolveIxSequenceId(cfg, "B2B2026", "invoice")).toBe(6476362);
    expect(await resolveIxSequenceId(cfg, "B2B2026", "invoice_receipt")).toBe(6476364);
    expect(await resolveIxSequenceId(cfg, "B2B2026", "credit_note")).toBe(6476369);
  });

  it("finds the series whatever case it was configured in", async () => {
    stubFetch({ sequences: SERIES });
    expect(await resolveIxSequenceId(config("acct-case"), "b2b2026", "invoice")).toBe(6476362);
  });

  it("returns null for a series the account does not have", async () => {
    stubFetch({ sequences: SERIES });
    expect(await resolveIxSequenceId(config("acct-missing"), "FR2025", "invoice")).toBeNull();
  });

  // Null means "let IX use its default series". Callers that must not fall back
  // silently check ix_require_series and refuse the sale instead.
  it("returns null when the list does not answer", async () => {
    stubFetch({}, false);
    expect(await resolveIxSequenceId(config("acct-http-error"), "FR2026", "invoice")).toBeNull();
  });

  it("returns null when the call throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("DNS")));
    expect(await resolveIxSequenceId(config("acct-throw"), "FR2026", "invoice")).toBeNull();
  });

  it("does not call IX at all without credentials", async () => {
    const fetchMock = stubFetch({ sequences: SERIES });
    expect(await resolveIxSequenceId({ ix_account_name: null, ix_api_key: "k" }, "FR2026")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // An empty list on a transient hiccup must not freeze the lookup for the rest
  // of the isolate's life.
  it("does not cache an empty list", async () => {
    const fetchMock = stubFetch({ sequences: [] });
    const cfg = config("acct-empty");
    expect(await resolveIxSequenceId(cfg, "FR2026", "invoice")).toBeNull();
    stubFetch({ sequences: SERIES });
    expect(await resolveIxSequenceId(cfg, "FR2026", "invoice")).toBe(6211961);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
