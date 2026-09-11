import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The "yes" closes documents for real, so the two ways it could lie are pinned
 * here: reporting "done" while drafts are still waiting, and losing the count
 * across pages.
 *
 * `finalizeConnectionDrafts` caps a call at 100 rows, and a merchant who took a
 * fortnight to answer can have more than that. Closing the first hundred and
 * saying "feito" would be a lie with a fiscal tail.
 */

const finalizeConnectionDrafts = vi.fn();

vi.mock("./admin-connection", () => ({ finalizeConnectionDrafts: (...a: any[]) => finalizeConnectionDrafts(...a) }));
vi.mock("../services/connection-context", () => ({
  resolveConnectionContext: async () => ({ ok: true, ctx: { destination: "moloni" } }),
  connectionLabelOf: () => "Stripe → Moloni",
}));
vi.mock("../services/run-in", () => ({
  loadRunInRow: async () => ({ id: "c1", user_id: "user_1", destination_kind: "moloni", runin_answer: null }),
  tokenIsValid: () => true,
}));

const { handleRunInAnswer } = await import("./run-in");

const env = { DB: { prepare: () => ({ bind: () => ({ run: async () => ({}) }) }) } } as any;

/** One page of results, as finalizeConnectionDrafts reports them. */
const page = (finalized: number, has_more: boolean, next: number | null, errors = 0) =>
  ({ finalized, errors, has_more, next_after_rowid: next });

beforeEach(() => { finalizeConnectionDrafts.mockReset(); });

describe("handleRunInAnswer — yes", () => {
  it("walks the pages and counts every document it closed", async () => {
    finalizeConnectionDrafts
      .mockResolvedValueOnce(page(100, true, 4100))
      .mockResolvedValueOnce(page(37, false, null));

    const html = await (await handleRunInAnswer(env, "tok", "yes")).text();

    expect(finalizeConnectionDrafts).toHaveBeenCalledTimes(2);
    // The cursor, not an offset: the second call resumes where the first stopped.
    expect(finalizeConnectionDrafts.mock.calls[1][2].after_rowid).toBe(4100);
    expect(html).toContain("137 documentos");
    expect(html).toContain("Feito");
  });

  it("stops at three pages and says so rather than claiming it finished", async () => {
    finalizeConnectionDrafts.mockResolvedValue(page(100, true, 9));

    const html = await (await handleRunInAnswer(env, "tok", "yes")).text();

    // One request cannot afford more: each row costs a GET, often a PUT and a
    // state change, against Cloudflare's 1000-subrequest ceiling.
    expect(finalizeConnectionDrafts).toHaveBeenCalledTimes(3);
    expect(html).toContain("ainda há mais à espera");
    expect(html).not.toContain("<h1>Feito</h1>");
  });

  it("names the failures instead of burying them in a success page", async () => {
    finalizeConnectionDrafts.mockResolvedValueOnce(page(3, false, null, 2));

    const html = await (await handleRunInAnswer(env, "tok", "yes")).text();

    expect(html).toContain("2 ficaram por fechar");
    expect(html).not.toContain("<h1>Feito</h1>");
  });
});

describe("handleRunInAnswer — no", () => {
  it("closes nothing and hands over the support contacts", async () => {
    const html = await (await handleRunInAnswer(env, "tok", "no")).text();

    expect(finalizeConnectionDrafts).not.toHaveBeenCalled();
    expect(html).toContain("pedro@kapta.pt");
    expect(html).toContain("calendly.com/pedro-kapta/apoio-kapta");
  });
});
