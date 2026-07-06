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

// Returns the "PT | EN" mention for a code, or "" when the code has no mapping
// (caller then stamps nothing).
export function buildExemptionMention(code?: string | null): string {
  const m = code ? EXEMPTION_MENTIONS[code] : undefined;
  return m ? `${m.pt} | ${m.en}` : "";
}
