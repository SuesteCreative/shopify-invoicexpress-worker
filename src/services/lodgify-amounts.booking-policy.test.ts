import { describe, it, expect } from "vitest";
import {
  isOtaStayCollected,
  isBookingFullyCollected,
  otaPolicyFrom,
  otaStayCollectedSqlPredicate,
  parseBookingSubtotals,
  touristTaxGross,
  type OtaPolicy,
} from "./lodgify-amounts";

/**
 * `lodgify_ota_invoice_on = "booking"`: a confirmed booking is billed the moment
 * it exists in Lodgify. Asked for by Farracemota on 15/09/2026, a host none of
 * whose 302 bookings ever had a payment marked.
 */
const BOOKING: OtaPolicy = { on: "booking" };

describe("the booking policy", () => {
  it("is read off the connection, and only when stated", () => {
    expect(otaPolicyFrom({ lodgify_ota_invoice_on: "booking" })).toEqual(BOOKING);
    expect(otaPolicyFrom({ lodgify_ota_invoice_on: "Booking" })).toEqual(BOOKING);
    expect(otaPolicyFrom({})).toBeUndefined();
  });

  it("bills a future Airbnb stay nobody marked paid", () => {
    // Farracemota 23128453: created 14/09, stay 05→08/10, nothing paid or due.
    const item = {
      total_amount: 479, amount_paid: 0, amount_due: 0,
      source: "AirbnbIntegration", arrival: "2026-10-05", departure: "2026-10-08",
    };
    expect(isOtaStayCollected(item, BOOKING, "2026-09-15")).toBe(true);
    expect(isBookingFullyCollected(item, BOOKING)).toBe(true);
    // The stay-date policies keep waiting for the stay.
    expect(isOtaStayCollected(item, { on: "arrival" }, "2026-09-15")).toBe(false);
  });

  it("bills any channel, with or without money recorded", () => {
    const direct = {
      total_amount: 1127, amount_paid: 563.5, amount_due: 563.5,
      source: "OH", arrival: "2026-08-22", departure: "2026-08-29",
    };
    expect(isBookingFullyCollected(direct, BOOKING)).toBe(true);
    expect(isBookingFullyCollected({ ...direct, source: "", amount_paid: 0, amount_due: 1127 }, BOOKING)).toBe(true);
    expect(isBookingFullyCollected(direct, { on: "departure" })).toBe(false);
  });

  it("still bills nothing for a zero-total booking", () => {
    expect(isOtaStayCollected({ total_amount: 0, source: "AirbnbIntegration" }, BOOKING)).toBe(false);
  });
});

/**
 * The backlog alert and the recovery listing ask the same question in SQL. Every
 * policy, not just the new one, since none of the three had this check.
 */
describe("otaStayCollectedSqlPredicate agrees with isOtaStayCollected", () => {
  const PAST = { arrival: "2026-01-01", departure: "2026-01-05" };
  const FUTURE = { arrival: "2099-01-01", departure: "2099-01-05" };
  const FIXTURES = [
    { id: "ota_past", source: "AirbnbIntegration", total_amount: 500, amount_paid: 0, amount_due: 0, ...PAST },
    { id: "ota_future", source: "AirbnbIntegration", total_amount: 500, amount_paid: 0, amount_due: 0, ...FUTURE },
    { id: "ota_in_stay", source: "BookingCom", total_amount: 500, amount_paid: 0, amount_due: 0, arrival: "2026-01-01", departure: "2099-01-05" },
    { id: "ota_paid", source: "AirbnbIntegration", total_amount: 500, amount_paid: 500, amount_due: 0, ...PAST },
    { id: "ota_due", source: "AirbnbIntegration", total_amount: 500, amount_paid: 0, amount_due: 500, ...PAST },
    { id: "direct_unpaid", source: "OH", total_amount: 500, amount_paid: 0, amount_due: 500, ...PAST },
    { id: "direct_deposit", source: "OH", total_amount: 500, amount_paid: 250, amount_due: 250, ...FUTURE },
    { id: "zero_total", source: "AirbnbIntegration", total_amount: 0, amount_paid: 0, amount_due: 0, ...PAST },
    { id: "no_dates", source: "AirbnbIntegration", total_amount: 300, amount_paid: 0, amount_due: 0, arrival: null, departure: null },
    { id: "no_source", source: "", total_amount: 300, amount_paid: 0, amount_due: 0, ...PAST },
  ];

  for (const policy of [{ on: "arrival" }, { on: "departure" }, BOOKING] as OtaPolicy[]) {
    it(`agrees row for row on "${policy.on}"`, async () => {
      let DatabaseSync: any;
      try {
        // Specifier in a variable: tsc checks against @cloudflare/workers-types,
        // which has no node:sqlite declarations.
        const nodeSqlite = "node:sqlite";
        ({ DatabaseSync } = await import(nodeSqlite));
      } catch {
        console.warn("node:sqlite unavailable; skipping SQL/TS agreement check");
        return;
      }
      const db = new DatabaseSync(":memory:");
      db.exec(`CREATE TABLE lodgify_bookings (
        id TEXT PRIMARY KEY, source TEXT, total_amount REAL, amount_paid REAL, amount_due REAL,
        arrival TEXT, departure TEXT
      )`);
      const ins = db.prepare("INSERT INTO lodgify_bookings VALUES (?,?,?,?,?,?,?)");
      for (const f of FIXTURES) {
        ins.run(f.id, f.source, f.total_amount, f.amount_paid, f.amount_due, f.arrival, f.departure);
      }
      const fromSql = (db.prepare(
        `SELECT b.id FROM lodgify_bookings b WHERE ${otaStayCollectedSqlPredicate(policy)} ORDER BY b.id`,
      ).all() as Array<{ id: string }>).map((r) => r.id);
      db.close();
      // date('now') in the SQL, so the TS rule is asked about the same day.
      const fromTs = FIXTURES.filter((f) => isOtaStayCollected(f, policy)).map((f) => f.id).sort();
      expect(fromSql).toEqual(fromTs);
    });
  }
});

describe("the tourist tax in Lodgify's breakdown", () => {
  const subtotals = (over: Record<string, unknown>) =>
    parseBookingSubtotals({ stay: 299, promotions: 0, fees: 0, addons: 0, taxes: 12, vat: 0, ...over });

  it("keeps a breakdown whose only extra is the tax", () => {
    expect(subtotals({})).toEqual({ stay: 299, fees: 0, addons: 0, promotions: 0, taxes: 12, vat: 0 });
  });

  it("reads the tax when the breakdown adds up, discount included", () => {
    expect(touristTaxGross(311, subtotals({}))).toBe(12);
    expect(touristTaxGross(301, subtotals({ promotions: -10 }))).toBe(12);
  });

  it("is 0 when there is no tax to separate", () => {
    expect(touristTaxGross(288.14, null)).toBe(0);
    expect(touristTaxGross(669, subtotals({ stay: 554, fees: 115, taxes: 0 }))).toBe(0);
  });

  it("refuses a breakdown it cannot reconcile", () => {
    expect(touristTaxGross(311, subtotals({ stay: 250 }))).toBeNull();
    expect(touristTaxGross(10, subtotals({ stay: null }))).toBeNull();
  });
});
