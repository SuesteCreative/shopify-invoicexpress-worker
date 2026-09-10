// EU-27 ISO-2 codes used to gate the B2B reverse-charge branch. Cross-border
// EU sales with a valid VIES VAT id are eligible; same-country (PT↔PT) and
// non-EU (UK/CH/US/...) are not.
export const EU_COUNTRIES: ReadonlySet<string> = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR",
  "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL",
  "PL", "PT", "RO", "SK", "SI", "ES", "SE",
]);

// InvoiceXpress is PT-only today. v2 may read this off the IX account profile
// so EU sellers in other member states get the same treatment.
export const SELLER_COUNTRY = "PT";

export function isCrossBorderEU(buyerCountry: string | null | undefined): boolean {
  if (!buyerCountry) return false;
  const cc = buyerCountry.toUpperCase();
  return EU_COUNTRIES.has(cc) && cc !== SELLER_COUNTRY;
}

/**
 * How long a member state's VAT number is, counting only what follows the
 * two-letter country prefix.
 *
 * Used to reject a bare number that is the right shape for *some* country but
 * not for the buyer's. Measured on Wim Hof Method (10/09/2026): a Google
 * Analytics client id of ten digits was combined with a French billing country
 * and stamped on a real document as `FR1428932220` — France's VAT body is
 * eleven characters, so a length check alone would have caught it.
 *
 * Lengths are deliberately permissive where the member state itself is (RO
 * issues 2 to 10, CZ 8 to 10): this is a cheap shape gate, not a validator.
 * VIES remains the only authority on whether a number exists.
 */
export const EU_VAT_BODY_LENGTHS: Readonly<Record<string, readonly number[]>> = {
  AT: [9], BE: [10], BG: [9, 10], CY: [9], CZ: [8, 9, 10],
  DE: [9], DK: [8], EE: [9], ES: [9], FI: [8],
  FR: [11], GR: [9], HR: [11], HU: [8], IE: [8, 9],
  IT: [11], LT: [9, 12], LU: [8], LV: [11], MT: [8],
  NL: [12], PL: [10], PT: [9], RO: [2, 3, 4, 5, 6, 7, 8, 9, 10],
  SE: [12], SI: [8], SK: [10],
};

/** Whether `body` could be `cc`'s VAT number by length alone. */
export function isPlausibleEuVatLength(cc: string, body: string): boolean {
  const allowed = EU_VAT_BODY_LENGTHS[cc.toUpperCase()];
  if (!allowed) return false;
  return allowed.includes(body.length);
}
