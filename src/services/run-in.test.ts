import { describe, it, expect } from "vitest";
import { runInHoldsFinalize, wantsAutoFinalize, tokenIsValid, RUN_IN_TOKEN_TTL_MS } from "./run-in";

/**
 * The run-in decides whether a document is a draft or a fiscal fact, so the
 * three ways it could be wrong are the three things pinned here: it must not
 * hold when it is off, it must not lift on anything but an explicit "yes", and
 * it must hold when the database cannot answer.
 */

/** A D1 stand-in whose `first()` returns whatever the test hands it. */
function db(first: any) {
  return {
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => {
            if (first instanceof Error) throw first;
            return first;
          },
        }),
      }),
    },
    RUN_IN_ENABLED: "1",
  } as any;
}

describe("runInHoldsFinalize", () => {
  it("holds a connection whose merchant has not answered", async () => {
    expect(await runInHoldsFinalize(db({ runin_answer: null }), "stripe_connect", "user_1", "moloni")).toBe(true);
  });

  it("lifts only on an explicit yes", async () => {
    expect(await runInHoldsFinalize(db({ runin_answer: "yes" }), "stripe_connect", "user_1", "moloni")).toBe(false);
    // "no" is an answer, and the answer is that nothing gets certified.
    expect(await runInHoldsFinalize(db({ runin_answer: "no" }), "stripe_connect", "user_1", "moloni")).toBe(true);
  });

  it("holds when the row cannot be read", async () => {
    // Fails CLOSED. An extra draft costs a click; a certified document that
    // nobody approved costs a credit note.
    expect(await runInHoldsFinalize(db(new Error("D1 down")), "stripe_connect", "user_1", "moloni")).toBe(true);
  });

  it("never touches another source, or anything at all while it is off", async () => {
    expect(await runInHoldsFinalize(db({ runin_answer: null }), "shopify", "user_1", "invoicexpress")).toBe(false);
    expect(await runInHoldsFinalize(db({ runin_answer: null }), "stripe", "user_1", "invoicexpress")).toBe(false);
    expect(await runInHoldsFinalize(db({ runin_answer: null }), "lodgify", "user_1", "moloni")).toBe(false);
    const off = { ...db({ runin_answer: null }), RUN_IN_ENABLED: "0" };
    expect(await runInHoldsFinalize(off, "stripe_connect", "user_1", "moloni")).toBe(false);
  });

  it("does not hold a connection it does not govern", async () => {
    // No active row — a backfill against a paused connection, say.
    expect(await runInHoldsFinalize(db(null), "stripe_connect", "user_1", "moloni")).toBe(false);
  });
});

describe("wantsAutoFinalize", () => {
  it("enrols only connections that asked to certify automatically", () => {
    // Several merchants run draft-only on purpose. Enrolling them would mean
    // emailing them about a decision they made, then offering to undo it.
    expect(wantsAutoFinalize(JSON.stringify({ auto_finalize: true }))).toBe(true);
    expect(wantsAutoFinalize(JSON.stringify({ auto_finalize: false }))).toBe(false);
    expect(wantsAutoFinalize(JSON.stringify({}))).toBe(false);
    expect(wantsAutoFinalize(null)).toBe(false);
    expect(wantsAutoFinalize("{not json")).toBe(false);
  });

  it("reads the JSON boolean and not a number", () => {
    // projectConnectionBehaviour only projects booleans off the blob, so a 1
    // here would be stored, displayed as set, and never reach the adapter.
    expect(wantsAutoFinalize(JSON.stringify({ auto_finalize: 1 }))).toBe(false);
  });
});

describe("tokenIsValid", () => {
  const future = new Date(Date.now() + RUN_IN_TOKEN_TTL_MS).toISOString();
  const row = (over: any = {}) => ({ runin_token: "abc-123", runin_token_expires_at: future, ...over }) as any;

  it("accepts the token it minted", () => {
    expect(tokenIsValid(row(), "abc-123")).toBe(true);
  });

  it("refuses a wrong, expired or missing token", () => {
    expect(tokenIsValid(row(), "abc-124")).toBe(false);
    expect(tokenIsValid(row(), "abc-1234")).toBe(false);
    expect(tokenIsValid(row({ runin_token_expires_at: "2020-01-01T00:00:00.000Z" }), "abc-123")).toBe(false);
    // A missing expiry counts as expired, same as the OAuth state check.
    expect(tokenIsValid(row({ runin_token_expires_at: null }), "abc-123")).toBe(false);
    expect(tokenIsValid(null, "abc-123")).toBe(false);
  });
});
