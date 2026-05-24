// Rioko brand tokens — source of truth: docs/brand-guideline.md
// Mirrors the inline const block in backoffice/src/components/landing/Landing.tsx.

export const SURFACE     = "#0E1116";
export const SURFACE_2   = "#14181F";
export const PAPER       = "#EAEAE4";
export const PAPER_HOVER = "#F3F3ED";

export const FG     = "#F0F0F0";
export const FG_60  = "rgba(240,240,240,0.62)";
export const FG_40  = "rgba(240,240,240,0.40)";

export const INK    = "#14181F";
export const INK_60 = "rgba(20,24,31,0.62)";
export const INK_40 = "rgba(20,24,31,0.42)";

export const RULE       = "rgba(255,255,255,0.08)";
export const HAIRLINE   = "rgba(255,255,255,0.06)";
export const PAPER_RULE = "rgba(0,0,0,0.06)";

export const ACCENT     = "#028DC4";
export const ACCENT_HOT = "#5EEAD4";
export const SOON       = "#F59E0B";
// CRM-only: destructive intent. Not on landing.
export const DESTRUCTIVE = "#F43F5E";

export const HEADLINE_GRADIENT =
  "linear-gradient(135deg, #06B6D4 0%, #028DC4 55%, #0369A1 100%)";

export const EASE: [number, number, number, number] = [0.32, 0.72, 0, 1];

export const GLASS = {
  background: "rgba(255,255,255,0.03)",
  border: `1px solid ${HAIRLINE}`,
  backdropFilter: "blur(20px)",
  WebkitBackdropFilter: "blur(20px)",
  boxShadow:
    "inset 0 1px 0 rgba(255,255,255,0.06), 0 24px 48px -28px rgba(0,0,0,0.6)",
} as const;
