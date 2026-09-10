import { describe, it, expect } from "vitest";
import {
  CONNECTION_FISCAL_IDENTITY,
  CONNECTION_FISCAL_RATES,
  CONNECTION_FISCAL_TOGGLES,
  CONNECTION_FISCAL_FLAGS,
} from "./connection-context";
import { FISCAL_CONFIG_KEYS } from "../../backoffice/src/lib/redact";

/**
 * A setting the worker reads off a connection must be settable ON that
 * connection.
 *
 * `projectConnectionBehaviour` isolates these keys: for any non-Shopify source
 * they come from `destination_config_json` or are forced neutral, and the
 * account's legacy `integrations` row is never consulted. The console's write
 * path is gated by `EDITABLE_CONNECTION_KEYS`, which IS `FISCAL_CONFIG_KEYS`.
 * When a key is in the first list and not the second, the console shows the
 * field, writes it to the legacy row, and the worker ignores what it wrote —
 * a setting that reads back as "off" with no error anywhere.
 *
 * This has now happened three times: the migration-0037 switches, the fiscal
 * identity (series / document type / exemption code), and the tax behaviour
 * (`oss_enabled`, `b2b_reverse_charge`, the two forced rates). Measured on Wim
 * Hof Method: `oss_enabled` toggled in the console, stored on the legacy row,
 * projected as 0 on every Stripe sale.
 *
 * The two lists live in different apps on purpose — one is the worker's
 * contract, the other is what may reach a browser — so nothing but a test can
 * hold them together.
 */
describe("every isolated connection setting is writable from the console", () => {
  const allowed = new Set<string>(FISCAL_CONFIG_KEYS);

  const isolated: Array<[string, readonly string[]]> = [
    ["rates", CONNECTION_FISCAL_RATES],
    ["toggles", CONNECTION_FISCAL_TOGGLES],
    ["identity", CONNECTION_FISCAL_IDENTITY],
    ["flags", CONNECTION_FISCAL_FLAGS],
  ];

  for (const [group, keys] of isolated) {
    it(`${group}: ${keys.join(", ")}`, () => {
      expect(keys.filter((k) => !allowed.has(k))).toEqual([]);
    });
  }

  it("ix_b2b_exemption_reason, which is isolated by its own block", () => {
    // Not in any of the four lists above — `projectConnectionBehaviour` handles
    // it inline, because a blank string has to read as "not stated". Same
    // consequence if it is unwritable, so it is pinned here by name.
    expect(allowed.has("ix_b2b_exemption_reason")).toBe(true);
  });
});
