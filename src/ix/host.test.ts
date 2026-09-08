/**
 * The hostname bug that made document series a no-op in production.
 *
 * `resolveSequenceId` built `https://{account}.invoicexpress.com/sequences.json`
 * for production accounts. That host has no A or AAAA record — measured
 * 2026-09-08:
 *
 *   nslookup andramartinsvieir.invoicexpress.com      → no address records
 *   nslookup andramartinsvieir.app.invoicexpress.com  → 104.21.40.70, …
 *
 * So the fetch threw on DNS, the surrounding catch returned null, and the
 * document was created with no `sequence_id` at all — filed under the account's
 * default series, silently, on every production document. A merchant who
 * configured `ix_sequence_name`, or routed one series per destination country,
 * got the default series and no error to say so.
 *
 * The sandbox is a third host (`.macewindu.`), which is why this is a function
 * and not a constant.
 */

import { describe, it, expect } from "vitest";
import { ixAccountHost } from "./host";

describe("ixAccountHost", () => {
  it("uses the host that exists for a production account", () => {
    expect(ixAccountHost("andramartinsvieir", "production"))
      .toBe("https://andramartinsvieir.app.invoicexpress.com");
  });

  it("never builds the bare host, which does not resolve", () => {
    for (const env of ["production", "development", null, undefined, ""]) {
      expect(ixAccountHost("acct", env as any)).not.toBe("https://acct.invoicexpress.com");
    }
  });

  it("sends anything that is not production to the sandbox", () => {
    // Deliberately not a whitelist: an unset or unrecognised environment must
    // land on the sandbox, because the failure mode of guessing wrong in the
    // other direction is writing test documents into a real fiscal account.
    for (const env of ["development", "sandbox", null, undefined, ""]) {
      expect(ixAccountHost("acct", env as any))
        .toBe("https://acct.macewindu.invoicexpress.com");
    }
  });
});
