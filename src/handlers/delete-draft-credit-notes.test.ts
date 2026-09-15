import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The cleanup deletes, so what it refuses to touch matters more than what it removes.
 *
 * Estrela's invoice 268938986 carried nine credit-note drafts for one refund on
 * 2026-09-14, each minted by a retry whose finalize was refused. Clearing them
 * is safe precisely because a draft is not a fiscal document — and the same
 * call would be a disaster if it ever reached a finalized one.
 */

const changeState = vi.fn();
const relatedGet = vi.fn();

vi.mock("../api/ix", () => ({
  IxApi: {
    v2: {
      documents: { byId: { related: { get: (...a: any[]) => relatedGet(...a) } } },
      changeState: { post: (...a: any[]) => changeState(...a) },
    },
  },
}));

vi.mock("../storage", () => ({
  AppStorage: class {
    async startDevJob() { /* recorded elsewhere */ }
    async finishDevJob() { /* recorded elsewhere */ }
  },
}));

const { deleteDraftCreditNotes } = await import("./admin");

const config: any = {
  shopify_domain: "70wnnj-qa.myshopify.com",
  ix_account_name: "estrelacustomjewe",
  ix_api_key: "k",
  ix_environment: "production",
};

// IX returns `{documents: [...]}`, and reads a closed document back as
// "final" — not "finalized", which is the verb you POST to change_state.
const related = (docs: any[]) => ({ data: { documents: docs }, error: null });

beforeEach(() => {
  changeState.mockReset().mockResolvedValue({ error: null });
  relatedGet.mockReset();
});

describe("deleteDraftCreditNotes", () => {
  it("removes every draft credit note on the invoice", async () => {
    relatedGet.mockResolvedValue(related([
      { id: 270287832, type: "CreditNote", status: "draft" },
      { id: 270288460, type: "CreditNote", status: "draft" },
      { id: 270289090, type: "CreditNote", status: "draft" },
    ]));

    const res: any = await deleteDraftCreditNotes({} as any, config, "268938986");

    expect(res.status).toBe("success");
    expect(res.deleted).toEqual(["270287832", "270288460", "270289090"]);
    expect(changeState).toHaveBeenCalledTimes(3);
    expect(changeState.mock.calls[0][0].body).toMatchObject({
      type: "credit_note", id: 270287832, state: "deleted",
    });
  });

  it("never touches a finalized credit note", async () => {
    relatedGet.mockResolvedValue(related([
      { id: 270287832, type: "CreditNote", status: "draft" },
      { id: 111111111, type: "CreditNote", status: "final" },
    ]));

    const res: any = await deleteDraftCreditNotes({} as any, config, "268938986");

    expect(res.deleted).toEqual(["270287832"]);
    expect(res.kept_finalized).toEqual(["111111111"]);
    expect(changeState).toHaveBeenCalledTimes(1);
  });

  it("ignores related documents that are not credit notes", async () => {
    relatedGet.mockResolvedValue(related([
      { id: 999, type: "Invoice", status: "draft" },
      { id: 270287832, type: "CreditNote", status: "draft" },
    ]));

    const res: any = await deleteDraftCreditNotes({} as any, config, "268938986");

    expect(res.deleted).toEqual(["270287832"]);
    expect(changeState).toHaveBeenCalledTimes(1);
  });

  it("deletes nothing on a dry run and says what it would remove", async () => {
    relatedGet.mockResolvedValue(related([
      { id: 270287832, type: "CreditNote", status: "draft" },
      { id: 111111111, type: "CreditNote", status: "final" },
    ]));

    const res: any = await deleteDraftCreditNotes({} as any, config, "268938986", { dryRun: true });

    expect(res.would_delete).toEqual(["270287832"]);
    expect(res.kept_finalized).toEqual(["111111111"]);
    expect(changeState).not.toHaveBeenCalled();
  });

  it("reports the ones it could not delete instead of claiming success", async () => {
    relatedGet.mockResolvedValue(related([
      { id: 270287832, type: "CreditNote", status: "draft" },
      { id: 270288460, type: "CreditNote", status: "draft" },
    ]));
    changeState
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: { message: "locked" } });

    const res: any = await deleteDraftCreditNotes({} as any, config, "268938986");

    expect(res.status).toBe("error");
    expect(res.deleted).toEqual(["270287832"]);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].id).toBe("270288460");
  });
});
