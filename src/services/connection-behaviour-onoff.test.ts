import { describe, it, expect } from "vitest";
import { projectConnectionBehaviour } from "./connection-context";

/**
 * A connection's `auto_finalize` used to be read as a boolean and nothing else.
 * The setup wizard writes booleans, so it worked — until something else wrote
 * the number 1: a repair, a migration, a hand-edit in D1. Then the projection
 * skipped it, the legacy row's 0 stood, and the account issued drafts while its
 * own config said it was certifying, with nothing anywhere saying so.
 *
 * Measured on Wim Hof Method, 14/09/2026: `auto_finalize` set to 1 at 16:00
 * UTC, and a 258,85 € sale at 16:14 still came out a draft.
 */
const legacy = () => ({ user_id: "u", shopify_domain: null, auto_finalize: 0, ix_send_email: 0 } as any);

describe("a connection's on/off switches", () => {
  it("reads 1 the same as true", () => {
    expect(projectConnectionBehaviour(legacy(), { auto_finalize: 1 }).auto_finalize).toBe(1);
    expect(projectConnectionBehaviour(legacy(), { auto_finalize: true }).auto_finalize).toBe(1);
  });

  it("reads 0 the same as false, over a legacy row that says on", () => {
    const on = { ...legacy(), auto_finalize: 1 };
    expect(projectConnectionBehaviour({ ...on }, { auto_finalize: 0 }).auto_finalize).toBe(0);
    expect(projectConnectionBehaviour({ ...on }, { auto_finalize: false }).auto_finalize).toBe(0);
  });

  it("leaves the legacy value alone when the connection states nothing", () => {
    const on = { ...legacy(), auto_finalize: 1 };
    expect(projectConnectionBehaviour({ ...on }, {}).auto_finalize).toBe(1);
    // Not a statement of intent: a string, a null, anything unrecognised must
    // not be read as "off" — that would silence a connection that never spoke.
    expect(projectConnectionBehaviour({ ...on }, { auto_finalize: null }).auto_finalize).toBe(1);
    expect(projectConnectionBehaviour({ ...on }, { auto_finalize: "1" }).auto_finalize).toBe(1);
  });

  it("applies the same rule to the buyer email switch", () => {
    expect(projectConnectionBehaviour(legacy(), { send_email: 1 }).ix_send_email).toBe(1);
    expect(projectConnectionBehaviour(legacy(), { send_email: true }).ix_send_email).toBe(1);
  });
});
