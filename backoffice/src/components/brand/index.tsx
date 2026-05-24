"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";
import {
  ACCENT,
  ACCENT_HOT,
  DESTRUCTIVE,
  FG_40,
  HEADLINE_GRADIENT,
  RULE,
  SOON,
} from "@/lib/brand-tokens";

// Monospace inline span. Color defaults to mint accent.
export function Mono({
  children,
  color = ACCENT_HOT,
}: {
  children: ReactNode;
  color?: string;
}) {
  return (
    <span
      style={{
        fontFamily: "var(--font-mono), ui-monospace, monospace",
        color,
        letterSpacing: "-0.02em",
      }}
    >
      {children}
    </span>
  );
}

// Headline gradient text — wraps accent noun in cyan gradient.
export function Gradient({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        backgroundImage: HEADLINE_GRADIENT,
        WebkitBackgroundClip: "text",
        backgroundClip: "text",
        color: "transparent",
        WebkitTextFillColor: "transparent",
      }}
    >
      {children}
    </span>
  );
}

// Two-layer pulsing live dot. Inner static dot + animated ring.
export function LiveDot({ color = ACCENT_HOT }: { color?: string }) {
  return (
    <span className="relative inline-flex h-2 w-2 items-center justify-center">
      <span
        className="absolute inset-0 rounded-full"
        style={{ background: color, opacity: 0.9 }}
      />
      <motion.span
        className="absolute inset-0 rounded-full"
        style={{ background: color }}
        animate={{ scale: [1, 1.8, 1], opacity: [0.5, 0, 0.5] }}
        transition={{ duration: 2, repeat: Infinity, ease: "easeOut" }}
      />
    </span>
  );
}

// Eyebrow pill — mono uppercase label with a mint prefix dot.
export function Eyebrow({
  children,
  dotColor = ACCENT_HOT,
}: {
  children: ReactNode;
  dotColor?: string;
}) {
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full px-3 py-1 font-mono text-[10px] uppercase tracking-[0.22em]"
      style={{
        border: `1px solid ${RULE}`,
        background: "rgba(255,255,255,0.02)",
        color: FG_40,
      }}
    >
      <span
        className="h-1 w-1 rounded-full"
        style={{ background: dotColor }}
      />
      {children}
    </span>
  );
}

type StatusKind = "live" | "soon" | "planned" | "error";

const STATUS_STYLES: Record<
  StatusKind,
  { bg: string; fg: string; dot?: string; label: string }
> = {
  live: {
    bg: "rgba(2,141,196,0.12)",
    fg: ACCENT,
    dot: ACCENT,
    label: "Ativo",
  },
  soon: {
    bg: "rgba(154,106,31,0.14)",
    fg: "#7C4A0F",
    label: "Em breve",
  },
  planned: {
    bg: "rgba(20,24,31,0.08)",
    fg: "rgba(20,24,31,0.62)",
    label: "Em estudo",
  },
  error: {
    bg: "rgba(244,63,94,0.10)",
    fg: DESTRUCTIVE,
    dot: DESTRUCTIVE,
    label: "Erro",
  },
};

export function StatusBadge({
  status,
  label,
}: {
  status: StatusKind;
  label?: string;
}) {
  const cfg = STATUS_STYLES[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em]"
      style={{ background: cfg.bg, color: cfg.fg }}
    >
      {cfg.dot && (
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: cfg.dot }}
        />
      )}
      {label ?? cfg.label}
    </span>
  );
}

// Re-export tokens for convenience.
export {
  ACCENT,
  ACCENT_HOT,
  DESTRUCTIVE,
  HEADLINE_GRADIENT,
  RULE,
  SOON,
  FG_40,
};
