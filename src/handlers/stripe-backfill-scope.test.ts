import { describe, it, expect } from "vitest";
import { settleClaimed } from "./admin-stripe";

/**
 * A payment the merchant's other system invoices is settled, not unbilled.
 *
 * Escola Lá Fora (15/09/2026): scopeBlocker skipped eleven payments carrying
 * `submission_id` on purpose, wrote no processed_orders row for them, and the
 * backfill's landed-check turned each into "silent skip — STILL unbilled".
 */
describe("settleClaimed", () => {
  it("settles the out-of-scope payment and still escalates the unbilled one", () => {
    const results = [
      { external_id: "pi_landed", status: "created", message: "Invoice created via backfill" },
      { external_id: "pi_3UFYmHBp3wyQk8MN3rD4bYfN", status: "created", message: "Invoice created via backfill" },
      { external_id: "pi_silent", status: "created", message: "Invoice created via backfill" },
      { external_id: "pi_threw", status: "error", message: "Moloni: company not found" },
    ];

    settleClaimed(results, new Set(["pi_landed"]), new Set(["pi_3UFYmHBp3wyQk8MN3rD4bYfN"]));

    expect(results.map((r) => r.status)).toEqual(["created", "skipped", "error", "error"]);
    expect(results[3].message).toBe("Moloni: company not found");
  });
});
