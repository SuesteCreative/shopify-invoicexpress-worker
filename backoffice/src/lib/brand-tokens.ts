// Rioko brand tokens — source of truth: docs/brand-guideline.md
// Mirrors the inline const block in backoffice/src/components/landing/Landing.tsx.
//
// These are CSS custom properties rather than literals so the brand components
// follow the active skin. Each var() carries the original night value as its
// fallback, so night is unchanged even where a token is only declared for day.
// They are consumed as CSS values (inline style objects); nothing compares or
// parses them.

export const SURFACE     = "var(--background)";
export const SURFACE_2   = "var(--surface-2)";
export const PAPER       = "var(--paper, #EAEAE4)";
export const PAPER_HOVER = "var(--paper-hover, #F3F3ED)";

export const FG     = "var(--foreground)";
export const FG_60  = "var(--fg-60)";
export const FG_40  = "var(--fg-40)";

// Ink on the paper plane. That plane is light in BOTH skins, so these stay put.
export const INK    = "#14181F";
export const INK_60 = "rgba(20,24,31,0.62)";
export const INK_40 = "rgba(20,24,31,0.42)";

export const RULE       = "var(--rule)";
export const HAIRLINE   = "var(--hairline)";
export const PAPER_RULE = "var(--paper-edge, rgba(0,0,0,0.06))";

export const ACCENT     = "var(--accent)";
// The accent used as TYPE needs the deeper day ink; plates keep ACCENT.
export const ACCENT_INK = "var(--accent-ink)";
export const ACCENT_HOT = "var(--accent-hot)";
export const SOON       = "var(--soon)";
// CRM-only: destructive intent. Not on landing.
export const DESTRUCTIVE = "var(--destructive)";

export const HEADLINE_GRADIENT =
  "linear-gradient(135deg, var(--headline-1) 0%, var(--headline-2) 55%, var(--headline-3) 100%)";

export const EASE: [number, number, number, number] = [0.32, 0.72, 0, 1];

export const GLASS = {
  background: "var(--glass-bg)",
  border: `1px solid var(--glass-border)`,
  backdropFilter: "blur(var(--glass-blur))",
  WebkitBackdropFilter: "blur(var(--glass-blur))",
  boxShadow:
    "inset 0 1px 0 var(--glass-inset), var(--glass-shadow)",
} as const;

