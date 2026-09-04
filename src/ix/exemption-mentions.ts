// Bilingual legal mentions for PT VAT-exemption codes (SAF-T "Código de Motivo
// de Isenção"). Stamped into invoice/credit-note `observations` when a shop has
// ix_stamp_exemption_note = 1, so carriers/customs (e.g. UPS on US exports) see
// the exemption spelled out — IX itself only renders its own PT-only text from
// the M-code. The mention is DERIVED from the shop's configured exemption code,
// never hardcoded per client.
//
// Extend this map as other shops opt in with a different code.
export const EXEMPTION_MENTIONS: Record<string, { pt: string; en: string }> = {
  // Art. 14.º CIVA — exports of goods outside the EU.
  M05: {
    pt: "Isento de IVA ao abrigo do art.º 14.º do CIVA",
    en: "VAT exempt under Article 14 of the Portuguese VAT Code (CIVA)",
  },
};

/**
 * Mentions for the cross-border B2B codes, deliberately NOT in the map above.
 *
 * `EXEMPTION_MENTIONS` is read by `IxBuilder` for every shop with
 * `ix_stamp_exemption_note = 1`, so adding a code there changes what those
 * shops' documents say. These two are consulted only by the per-sale
 * classification (`src/ix/fiscal-classification.ts`), which is itself behind
 * `ix_derive_exemption` — so a shop that has not opted in cannot be affected by
 * them. Merge the two maps once the classification is the only path left.
 */
export const B2B_EXEMPTION_MENTIONS: Record<string, { pt: string; en: string }> = {
  // Art. 14.º RITI — intra-Community supply of goods to a VAT-registered buyer
  // in another member state, who accounts for the VAT at destination.
  M16: {
    pt: "Isento de IVA ao abrigo do art.º 14.º do RITI",
    en: "VAT exempt — intra-Community supply, Article 138 of Directive 2006/112/EC. Reverse charge applies",
  },
  // Reverse charge on services, and the generic autoliquidação wording.
  M40: {
    pt: "IVA - autoliquidação",
    en: "Reverse charge, Article 196 of Directive 2006/112/EC",
  },
};

/**
 * The mention for a code, looking in the B2B map first and falling back to the
 * shared one. Used by the per-sale classification, which may land on either an
 * export code (M05, shared) or a B2B code (M16/M40).
 */
export function buildAnyExemptionMention(code?: string | null): string {
  const b2b = code ? B2B_EXEMPTION_MENTIONS[code] : undefined;
  if (b2b) return `${b2b.pt} | ${b2b.en}`;
  return buildExemptionMention(code);
}

// Returns the "PT | EN" mention for a code, or "" when the code has no mapping
// (caller then stamps nothing).
export function buildExemptionMention(code?: string | null): string {
  const m = code ? EXEMPTION_MENTIONS[code] : undefined;
  return m ? `${m.pt} | ${m.en}` : "";
}
