import { describe, it, expect } from "vitest";
import { AppStorage } from "./storage";

// One refund, one credit note. These pin the ledger that replaced a remote read
// as the answer to "has this refund been credited?" — the read whose error was
// discarded, so a failed lookup said "no credit notes yet" and one Bikini Books
// refund became 22 credit notes in an hour on 2026-09-14.

type Row = { state: string; credit_note_id: string | null; claimed_at: string; amount: number | null; invoice_id: string };

/** A D1 stand-in honouring PRIMARY KEY (scope, refund_id) on `credit_notes`. */
function fakeDb(rows = new Map<string, Row>()) {
  return {
    rows,
    prepare(sql: string) {
      let args: any[] = [];
      const api = {
        bind(...a: any[]) { args = a; return api; },
        async run() {
          if (sql.includes("INSERT OR IGNORE INTO credit_notes")) {
            const [scope, refund, invoice, amount, claimedAt] = args;
            const key = `${scope}|${refund}`;
            if (rows.has(key)) return { meta: { changes: 0 } };
            rows.set(key, { state: "issuing", credit_note_id: null, claimed_at: claimedAt, amount, invoice_id: invoice });
            return { meta: { changes: 1 } };
          }
          if (sql.includes("UPDATE credit_notes SET claimed_at")) {
            const [at, , scope, refund, cutoff] = args;
            const row = rows.get(`${scope}|${refund}`);
            if (!row || row.credit_note_id != null || !(row.claimed_at < cutoff)) return { meta: { changes: 0 } };
            row.claimed_at = at;
            return { meta: { changes: 1 } };
          }
          if (sql.includes("SET state = 'issued'")) {
            const [creditNoteId, amount, , scope, refund] = args;
            const row = rows.get(`${scope}|${refund}`);
            if (row) Object.assign(row, { state: "issued", credit_note_id: creditNoteId, amount });
            return { meta: { changes: 1 } };
          }
          if (sql.includes("SET state = 'refused'")) {
            const [, , scope, refund] = args;
            const row = rows.get(`${scope}|${refund}`);
            if (row) row.state = "refused";
            return { meta: { changes: 1 } };
          }
          if (sql.includes("SET credit_note_id = ?")) {
            const [creditNoteId, , , scope, refund] = args;
            const row = rows.get(`${scope}|${refund}`);
            if (row) row.credit_note_id = creditNoteId;
            return { meta: { changes: 1 } };
          }
          if (sql.includes("DELETE FROM credit_notes")) {
            const [scope, refund] = args;
            const key = `${scope}|${refund}`;
            const row = rows.get(key);
            if (row && row.state === "issuing" && row.credit_note_id == null) rows.delete(key);
            return { meta: { changes: 1 } };
          }
          throw new Error(`unexpected sql: ${sql}`);
        },
        async first() {
          if (sql.includes("SELECT state, credit_note_id")) {
            const [scope, refund] = args;
            return rows.get(`${scope}|${refund}`) ?? null;
          }
          if (sql.includes("SUM(amount)")) {
            const [scope, invoice] = args;
            let total = 0;
            for (const [key, row] of rows) {
              if (key.startsWith(`${scope}|`) && row.invoice_id === invoice && row.state === "issued") total += row.amount ?? 0;
            }
            return { total };
          }
          throw new Error(`unexpected sql: ${sql}`);
        },
      };
      return api;
    },
  } as any;
}

const storage = (db: any) => new AppStorage({ DB: db, INVOICE_KV: {} as any } as any, "shop.myshopify.com");
const SCOPE = "user_1", INVOICE = "270254728";

describe("claimRefundCredit", () => {
  it("lets exactly one of two concurrent deliveries issue the credit note", async () => {
    const db = fakeDb();
    const a = storage(db), b = storage(db);
    const [first, second] = await Promise.all([
      a.claimRefundCredit(SCOPE, "1041494835476", INVOICE, 15),
      b.claimRefundCredit(SCOPE, "1041494835476", INVOICE, 15),
    ]);
    expect([first.status, second.status].filter(s => s === "won")).toHaveLength(1);
  });

  it("answers 'done' for ever once the credit note is issued", async () => {
    const db = fakeDb();
    const s = storage(db);
    expect((await s.claimRefundCredit(SCOPE, "r1", INVOICE, 15)).status).toBe("won");
    await s.markRefundCredited(SCOPE, "r1", "270274337", 15);
    const again = await s.claimRefundCredit(SCOPE, "r1", INVOICE, 15);
    expect(again.status).toBe("done");
    expect(again.creditNoteId).toBe("270274337");
  });

  it("answers 'done' once refused, so a refusal is not retried for ever", async () => {
    const db = fakeDb();
    const s = storage(db);
    await s.claimRefundCredit(SCOPE, "r1", INVOICE, 5);
    await s.markRefundCreditRefused(SCOPE, "r1", "não se espelha na fatura");
    expect((await s.claimRefundCredit(SCOPE, "r1", INVOICE, 5)).status).toBe("done");
  });

  it("still allows a second, different refund against the same invoice", async () => {
    const db = fakeDb();
    const s = storage(db);
    await s.claimRefundCredit(SCOPE, "1041494835476", INVOICE, 15);
    await s.markRefundCredited(SCOPE, "1041494835476", "270274337", 15);
    // The other refund on OL1373 — the book. It must go through.
    expect((await s.claimRefundCredit(SCOPE, "1041494901012", INVOICE, 42)).status).toBe("won");
  });

  it("takes over a claim whose holder died, but only while no document exists", async () => {
    const db = fakeDb();
    const s = storage(db);
    await s.claimRefundCredit(SCOPE, "r1", INVOICE, 15);
    db.rows.get(`${SCOPE}|r1`).claimed_at = new Date(Date.now() - 3600_000).toISOString();
    expect((await s.claimRefundCredit(SCOPE, "r1", INVOICE, 15)).status).toBe("won");

    // Now a draft really is sitting at the destination. Taking the claim over
    // would put a twin beside it — which is how 19 drafts accumulated.
    await s.noteRefundCreditDraft(SCOPE, "r1", "270277803", "não certificado");
    db.rows.get(`${SCOPE}|r1`).claimed_at = new Date(Date.now() - 3600_000).toISOString();
    const held = await s.claimRefundCredit(SCOPE, "r1", INVOICE, 15);
    expect(held.status).toBe("held");
    expect(held.creditNoteId).toBe("270277803");
  });

  it("gives the row back when nothing was created, so a retry may try again", async () => {
    const db = fakeDb();
    const s = storage(db);
    await s.claimRefundCredit(SCOPE, "r1", INVOICE, 15);
    await s.releaseRefundCredit(SCOPE, "r1");
    expect((await s.claimRefundCredit(SCOPE, "r1", INVOICE, 15)).status).toBe("won");
  });

  it("fails CLOSED when the ledger cannot be reached", async () => {
    // The opposite of claimOrder, on purpose: here the alternative to waiting is
    // a second certified credit note, which only a human can undo.
    const broken = { prepare() { throw new Error("D1 down"); } } as any;
    expect((await storage(broken).claimRefundCredit(SCOPE, "r1", INVOICE, 15)).status).toBe("blocked");
  });
});

describe("creditedTotalForInvoice", () => {
  it("adds up only what was actually issued against that invoice", async () => {
    const db = fakeDb();
    const s = storage(db);
    for (const [refund, amount] of [["a", 15], ["b", 15], ["c", 15]] as const) {
      await s.claimRefundCredit(SCOPE, refund, INVOICE, amount);
      await s.markRefundCredited(SCOPE, refund, `cn-${refund}`, amount);
    }
    await s.claimRefundCredit(SCOPE, "d", INVOICE, 15);        // still issuing
    await s.claimRefundCredit(SCOPE, "e", "999", 99);
    await s.markRefundCredited(SCOPE, "e", "cn-e", 99);        // another invoice
    expect(await s.creditedTotalForInvoice(SCOPE, INVOICE)).toBe(45);
  });

  it("returns null, never zero, when the ledger does not answer", async () => {
    // Read as zero, this is how a fourth credit note gets issued against an
    // invoice that is already fully credited.
    const broken = { prepare() { throw new Error("D1 down"); } } as any;
    expect(await storage(broken).creditedTotalForInvoice(SCOPE, INVOICE)).toBeNull();
  });
});
