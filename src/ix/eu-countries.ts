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
