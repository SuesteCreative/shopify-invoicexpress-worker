"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Link } from "@/i18n/navigation";
import Image from "next/image";
import { useEffect, useState, memo } from "react";
import { useTranslations } from "next-intl";
import {
  ArrowUpRight,
  ArrowRight,
  Check,
  Clock,
  Plug,
  FileText,
  ShieldCheck,
  ScrollText,
  Layers,
  Workflow,
  Sparkle,
  Menu,
  X,
  ChevronDown,
} from "lucide-react";
import { LangToggle } from "./LangToggle";

// ─────────────────────────────────────────────────────────────
// Design tokens
// ─────────────────────────────────────────────────────────────
const SURFACE = "#0E1116";
const SURFACE_2 = "#14181F";
const FG = "#F0F0F0";
const FG_60 = "rgba(240,240,240,0.62)";
const FG_40 = "rgba(240,240,240,0.40)";
const RULE = "rgba(255,255,255,0.08)";
const HAIRLINE = "rgba(255,255,255,0.06)";
const ACCENT = "#028DC4";
const ACCENT_HOT = "#5EEAD4";

const PAPER = "#EAEAE4";
const PAPER_RULE = "rgba(0,0,0,0.06)";
const INK = "#14181F";
const INK_60 = "rgba(20,24,31,0.62)";
const INK_40 = "rgba(20,24,31,0.42)";

const EASE: [number, number, number, number] = [0.32, 0.72, 0, 1];

const GLASS = {
  background: "rgba(255,255,255,0.03)",
  border: `1px solid ${HAIRLINE}`,
  backdropFilter: "blur(20px)",
  WebkitBackdropFilter: "blur(20px)",
  boxShadow:
    "inset 0 1px 0 rgba(255,255,255,0.06), 0 24px 48px -28px rgba(0,0,0,0.6)",
} as const;

// ─────────────────────────────────────────────────────────────
// Integration registry — notes resolved via i18n
// ─────────────────────────────────────────────────────────────
type Status = "live" | "soon" | "planned";

type Integration = {
  id: string;
  name: string;
  kind: "pagamentos" | "faturação";
  status: Status;
  logoSrc?: string;
  mark?: string;
  brand?: string;
};

const INTEGRATIONS: Integration[] = [
  { id: "shopify", name: "Shopify", kind: "pagamentos", status: "live", logoSrc: "/images/shopify-logo.webp" },
  { id: "stripe", name: "Stripe", kind: "pagamentos", status: "live", logoSrc: "/images/stripe-logo.svg" },
  { id: "eupago", name: "EuPago", kind: "pagamentos", status: "soon", logoSrc: "/images/eupago-logo.svg" },
  { id: "easypay", name: "Easypay", kind: "pagamentos", status: "soon", logoSrc: "/images/easypay-logo.svg" },
  { id: "ifthenpay", name: "Ifthenpay", kind: "pagamentos", status: "planned", logoSrc: "/images/ifthenpay-logo.svg" },
  { id: "invoicexpress", name: "InvoiceXpress", kind: "faturação", status: "live", logoSrc: "/images/invoicexpress-logo.svg" },
  { id: "moloni", name: "Moloni", kind: "faturação", status: "planned", logoSrc: "/images/moloni-logo.svg" },
  { id: "vendus", name: "Vendus", kind: "faturação", status: "planned", logoSrc: "/images/vendus-logo.svg" },
];

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function Mono({
  children,
  color = ACCENT_HOT,
}: {
  children: React.ReactNode;
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

const HEADLINE_GRADIENT =
  "linear-gradient(135deg, #06B6D4 0%, #028DC4 55%, #0369A1 100%)";

function Gradient({ children }: { children: React.ReactNode }) {
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

// Shared rich-text component map for t.rich() calls
const RICH_ELEMENTS = {
  g: (chunks: React.ReactNode) => <Gradient>{chunks}</Gradient>,
  h: (chunks: React.ReactNode) => (
    <span style={{ color: ACCENT_HOT }}>{chunks}</span>
  ),
  br: () => <br />,
  muted: (chunks: React.ReactNode) => (
    <span style={{ color: FG_60 }}>{chunks}</span>
  ),
} as const;

// ─────────────────────────────────────────────────────────────
// Flow slot registries — sub strings via i18n
// ─────────────────────────────────────────────────────────────
type FlowSlot = {
  id: string;
  title: string;
  logoSrc: string | null;
  mark?: string;
  brand?: string;
};

const ORIGIN_SLOTS: FlowSlot[] = [
  { id: "shopify", title: "Shopify", logoSrc: "/images/shopify-logo.webp" },
  { id: "stripe", title: "Stripe", logoSrc: "/images/stripe-logo.svg" },
  { id: "easypay", title: "Easypay", logoSrc: "/images/easypay-logo.svg" },
  { id: "eupago", title: "EuPago", logoSrc: "/images/eupago-logo.svg" },
  { id: "ifthenpay", title: "Ifthenpay", logoSrc: "/images/ifthenpay-logo.svg" },
];

const DESTINATION_SLOTS: FlowSlot[] = [
  { id: "invoicexpress", title: "InvoiceXpress", logoSrc: "/images/invoicexpress-logo.svg" },
  { id: "moloni", title: "Moloni", logoSrc: "/images/moloni-logo.svg" },
  { id: "vendus", title: "Vendus", logoSrc: "/images/vendus-logo.svg" },
];

const ROTATION_MS = 3200;
const PIPELINE_STEPS = ["NIF", "IVA", "Cliente", "M99"] as const;

// ─────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────
export default function Landing() {
  useEffect(() => {
    const prev = {
      bg: document.body.style.backgroundColor,
      color: document.body.style.color,
    };
    document.body.style.backgroundColor = SURFACE;
    document.body.style.color = FG;
    return () => {
      document.body.style.backgroundColor = prev.bg;
      document.body.style.color = prev.color;
    };
  }, []);

  return (
    <div
      className="relative min-h-[100dvh] w-full overflow-x-hidden"
      style={{
        backgroundColor: SURFACE,
        color: FG,
        "--surface": SURFACE,
        "--surface-2": SURFACE_2,
        "--fg": FG,
        "--rule": RULE,
        "--hairline": HAIRLINE,
        "--accent": ACCENT,
      } as React.CSSProperties}
    >
      <style>{`
        @keyframes rk-flow-down {
          from { background-position-y: 0px; }
          to   { background-position-y: 8px; }
        }
        @keyframes rk-pulse-ring {
          0%   { transform: scale(1); opacity: 0.5; }
          80%  { transform: scale(2.4); opacity: 0; }
          100% { transform: scale(2.4); opacity: 0; }
        }
      `}</style>

      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0"
        style={{
          backgroundImage: `radial-gradient(60% 40% at 8% 0%, rgba(2,141,196,0.10), transparent 60%),
                            radial-gradient(50% 35% at 100% 100%, rgba(94,234,212,0.06), transparent 60%)`,
        }}
      />

      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 z-0 h-[900px]"
        style={{
          backgroundImage:
            "radial-gradient(60% 50% at 50% 0%, rgba(255,255,255,0.04), transparent 70%)",
        }}
      />

      <Nav />

      <main className="relative z-10">
        <Hero />
        <IntegrationMatrix />
        <HowItWorks />
        <FiscalTrust />
        <Pricing />
        <Faq />
        <FinalCTA />
        <Footer />
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Nav
// ─────────────────────────────────────────────────────────────
function Nav() {
  const t = useTranslations("landing.nav");
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="relative z-50 px-4 pt-6 md:pt-8">
      <motion.nav
        initial={{ y: -16, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.7, ease: EASE }}
        className="mx-auto flex w-full max-w-[1280px] items-center justify-between gap-3 sm:gap-4 rounded-full px-1.5 sm:px-2 py-2"
        style={{
          ...GLASS,
          background: "rgba(20,24,31,0.62)",
        }}
      >
        <div className="flex items-center gap-3 pl-3 md:pl-8">
          <Image
            src="/images/rioko2-logo.svg"
            alt="Rioko 2.0"
            width={132}
            height={27}
            priority
            className="w-[100px] h-auto sm:w-[132px]"
          />
          <span
            className="hidden font-mono text-[10px] uppercase tracking-[0.18em] sm:inline-block"
            style={{ color: FG_40 }}
          >
            {t("hubChip")}
          </span>
        </div>

        <div className="hidden items-center gap-7 md:flex">
          <a href="#integracoes" className="text-[13px] transition-colors hover:opacity-100" style={{ color: FG_60 }}>
            {t("integrations")}
          </a>
          <a href="#como-funciona" className="text-[13px] transition-colors" style={{ color: FG_60 }}>
            {t("how")}
          </a>
          <a href="#preco" className="text-[13px] transition-colors" style={{ color: FG_60 }}>
            {t("pricing")}
          </a>
          <a href="#fiscal" className="text-[13px] transition-colors" style={{ color: FG_60 }}>
            {t("compliance")}
          </a>
          <a href="#faq" className="text-[13px] transition-colors" style={{ color: FG_60 }}>
            {t("faq")}
          </a>
        </div>

        <div className="flex items-center gap-2">
          <div className="hidden sm:inline-flex">
            <LangToggle variant="dark" />
          </div>
          <Link
            href="/sign-in"
            className="hidden px-4 py-2 text-[13px] sm:inline-block"
            style={{ color: FG }}
          >
            {t("signIn")}
          </Link>
          <button
            className="flex h-9 w-9 items-center justify-center rounded-full md:hidden"
            style={{ background: "rgba(255,255,255,0.06)", color: FG }}
            onClick={() => setMenuOpen((v) => !v)}
            aria-label={menuOpen ? t("closeMenu") : t("openMenu")}
            aria-expanded={menuOpen}
          >
            {menuOpen ? (
              <X className="h-4 w-4" strokeWidth={1.6} />
            ) : (
              <Menu className="h-4 w-4" strokeWidth={1.6} />
            )}
          </button>
          <Link
            href="/sign-up"
            className="group inline-flex items-center gap-1.5 sm:gap-2 rounded-full py-2 pl-3 sm:pl-4 pr-1.5 sm:pr-2 text-[12px] sm:text-[13px] font-medium transition-all duration-500 active:scale-[0.98]"
            style={{
              background: FG,
              color: SURFACE,
              boxShadow:
                "0 1px 0 rgba(0,0,0,0.08) inset, 0 8px 20px -10px rgba(0,0,0,0.6)",
              transitionTimingFunction: "cubic-bezier(0.32,0.72,0,1)",
            }}
          >
            {t("start")}
            <span
              className="flex h-7 w-7 items-center justify-center rounded-full transition-transform duration-500 group-hover:translate-x-[1px] group-hover:-translate-y-[1px]"
              style={{
                background: "rgba(0,0,0,0.08)",
                transitionTimingFunction: "cubic-bezier(0.32,0.72,0,1)",
              }}
            >
              <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.6} />
            </span>
          </Link>
        </div>
      </motion.nav>

      <AnimatePresence>
        {menuOpen && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.22, ease: EASE }}
            className="mx-auto mt-2 w-full max-w-[1280px] overflow-hidden rounded-2xl md:hidden"
            style={{
              background: "rgba(20,24,31,0.96)",
              border: `1px solid ${HAIRLINE}`,
              backdropFilter: "blur(24px)",
              WebkitBackdropFilter: "blur(24px)",
            }}
          >
            <nav className="flex flex-col gap-1 p-3">
              {[
                { href: "#integracoes", label: t("integrations") },
                { href: "#como-funciona", label: t("how") },
                { href: "#preco", label: t("pricing") },
                { href: "#fiscal", label: t("compliance") },
                { href: "#faq", label: t("faq") },
              ].map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  onClick={() => setMenuOpen(false)}
                  className="rounded-xl px-4 py-3 text-[15px] transition-opacity hover:opacity-80"
                  style={{ color: FG_60 }}
                >
                  {link.label}
                </a>
              ))}
              <div className="mt-1 border-t pt-3" style={{ borderColor: HAIRLINE }}>
                <Link
                  href="/sign-in"
                  onClick={() => setMenuOpen(false)}
                  className="block rounded-xl px-4 py-3 text-[15px]"
                  style={{ color: FG }}
                >
                  {t("signIn")}
                </Link>
                <div className="px-4 py-3">
                  <LangToggle variant="dark" />
                </div>
              </div>
            </nav>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Hero
// ─────────────────────────────────────────────────────────────
function Hero() {
  const t = useTranslations("landing.hero");

  return (
    <section className="relative px-4 pt-14 md:pt-24">
      <div className="mx-auto grid w-full max-w-[1280px] grid-cols-1 gap-12 md:grid-cols-12 md:gap-10">
        <div className="md:col-span-7">
          <motion.div
            initial={{ y: 12, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.6, ease: EASE, delay: 0.05 }}
            className="mb-7 inline-flex items-center gap-2 rounded-full px-3 py-1.5"
            style={{
              border: `1px solid ${RULE}`,
              background: "rgba(255,255,255,0.03)",
            }}
          >
            <LiveDot />
            <span
              className="font-mono text-[10px] uppercase tracking-[0.22em]"
              style={{ color: FG_60 }}
            >
              {t("chip")}
            </span>
          </motion.div>

          <motion.h1
            initial={{ y: 18, opacity: 0, filter: "blur(6px)" }}
            animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
            transition={{ duration: 0.9, ease: EASE, delay: 0.1 }}
            className="tracking-[-0.025em]"
            style={{
              fontFamily: "var(--font-sans-display), system-ui, sans-serif",
              fontSize: "clamp(2.5rem, 6vw, 5.5rem)",
              lineHeight: 0.97,
              color: FG,
              fontWeight: 500,
              textWrap: "balance" as const,
            }}
          >
            {t.rich("h1", RICH_ELEMENTS)}
          </motion.h1>

          <motion.p
            initial={{ y: 12, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.7, ease: EASE, delay: 0.25 }}
            className="mt-7 max-w-[52ch] text-[16px] leading-[1.55]"
            style={{ color: FG_60 }}
          >
            {t.rich("body", RICH_ELEMENTS)}
          </motion.p>

          <motion.div
            initial={{ y: 12, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.7, ease: EASE, delay: 0.35 }}
            className="mt-9 flex flex-wrap items-center gap-4"
          >
            <Link
              href="/sign-up"
              className="group inline-flex items-center gap-2 rounded-full py-3 pl-6 pr-2 text-[14px] font-medium transition-transform duration-500 active:scale-[0.98]"
              style={{
                background: FG,
                color: SURFACE,
                transitionTimingFunction: "cubic-bezier(0.32,0.72,0,1)",
                boxShadow:
                  "0 1px 0 rgba(0,0,0,0.08) inset, 0 14px 30px -16px rgba(0,0,0,0.6)",
              }}
            >
              {t("ctaCreate")}
              <span
                className="flex h-8 w-8 items-center justify-center rounded-full transition-transform duration-500 group-hover:translate-x-[2px] group-hover:-translate-y-[1px]"
                style={{
                  background: "rgba(0,0,0,0.08)",
                  transitionTimingFunction: "cubic-bezier(0.32,0.72,0,1)",
                }}
              >
                <ArrowUpRight className="h-4 w-4" strokeWidth={1.6} />
              </span>
            </Link>

            <a
              href="#integracoes"
              className="group inline-flex items-center gap-2 text-[14px]"
              style={{ color: FG }}
            >
              <span
                className="border-b transition-[border-color]"
                style={{ borderColor: "rgba(255,255,255,0.16)" }}
              >
                {t("ctaSee")}
              </span>
              <ArrowRight
                className="h-3.5 w-3.5 transition-transform duration-500 group-hover:translate-x-1"
                strokeWidth={1.6}
              />
            </a>
          </motion.div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 1, ease: EASE, delay: 0.55 }}
            className="mt-14 grid max-w-[560px] grid-cols-1 sm:grid-cols-3 gap-6 border-t pt-6"
            style={{ borderColor: RULE }}
          >
            <Stat value={t("stat1Value")} label={t("stat1Label")} />
            <Stat value={t("stat2Value")} label={t("stat2Label")} />
            <Stat value={t("stat3Value")} label={t("stat3Label")} />
          </motion.div>
        </div>

        <div className="md:col-span-5">
          <HeroShowcase />
        </div>
      </div>
    </section>
  );
}

function LiveDot() {
  return (
    <span className="relative flex h-1.5 w-1.5 items-center justify-center">
      <motion.span
        className="absolute inset-0 rounded-full"
        style={{ background: ACCENT_HOT }}
        animate={{ scale: [1, 1.8, 1], opacity: [0.5, 0, 0.5] }}
        transition={{ duration: 2, repeat: Infinity, ease: "easeOut" }}
      />
      <span
        className="relative h-1.5 w-1.5 rounded-full"
        style={{ background: ACCENT_HOT }}
      />
    </span>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <div
        className="font-mono text-[16px] tabular-nums sm:text-[22px]"
        style={{ color: FG, letterSpacing: "-0.01em" }}
      >
        {value}
      </div>
      <div
        className="mt-1 text-[10px] uppercase tracking-[0.18em]"
        style={{ color: FG_40 }}
      >
        {label}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Hero showcase
// ─────────────────────────────────────────────────────────────
function HeroShowcase() {
  const t = useTranslations("landing.showcase");
  const [originIdx, setOriginIdx] = useState(0);
  const [destIdx, setDestIdx] = useState(0);

  useEffect(() => {
    let destInterval: ReturnType<typeof setInterval> | null = null;

    const originInterval = setInterval(() => {
      setOriginIdx((p) => (p + 1) % ORIGIN_SLOTS.length);
    }, ROTATION_MS);

    const destStart = setTimeout(() => {
      destInterval = setInterval(() => {
        setDestIdx((p) => (p + 1) % DESTINATION_SLOTS.length);
      }, ROTATION_MS);
    }, ROTATION_MS / 2);

    return () => {
      clearInterval(originInterval);
      clearTimeout(destStart);
      if (destInterval) clearInterval(destInterval);
    };
  }, []);

  return (
    <motion.div
      initial={{ y: 24, opacity: 0, filter: "blur(8px)" }}
      animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
      transition={{ duration: 1, ease: EASE, delay: 0.3 }}
      className="relative"
    >
      <div
        className="rounded-[1.75rem] p-1.5"
        style={{ background: "rgba(255,255,255,0.04)" }}
      >
        <div
          className="overflow-hidden rounded-[calc(1.75rem-0.375rem)] p-6"
          style={{
            ...GLASS,
            background: "rgba(20,24,31,0.7)",
          }}
        >
          <RotatingFlowCard
            label={t("flowOrigin")}
            slots={ORIGIN_SLOTS}
            idx={originIdx}
          />

          <FlowConnector animated />

          <EngineCard destIdx={destIdx} />

          <FlowConnector animated />

          <RotatingFlowCard
            label={t("flowDest")}
            slots={DESTINATION_SLOTS}
            idx={destIdx}
            tone="success"
          />

          <div
            className="mt-5 flex items-center justify-between border-t pt-4 text-[11px]"
            style={{ borderColor: HAIRLINE, color: FG_40 }}
          >
            <span className="font-mono uppercase tracking-[0.16em]">
              {t("live")}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Clock className="h-3 w-3" strokeWidth={1.5} />
              {t("timeAgo")}
            </span>
          </div>
        </div>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, ease: EASE, delay: 1.7 }}
        className="mt-5 flex justify-center"
      >
        <div
          className="inline-flex items-center gap-2 rounded-full px-4 py-2"
          style={{
            border: `1px solid ${RULE}`,
            background: "rgba(255,255,255,0.03)",
            color: ACCENT_HOT,
          }}
        >
          <span className="font-mono text-[10px] uppercase tracking-[0.22em]">
            {t("tagline")}
          </span>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────
// Rotating flow card
// ─────────────────────────────────────────────────────────────
const RotatingFlowCard = memo(function RotatingFlowCard({
  label,
  slots,
  idx,
  tone,
}: {
  label: string;
  slots: FlowSlot[];
  idx: number;
  tone?: "success";
}) {
  const tShowcase = useTranslations("landing.showcase");
  const tSlots = useTranslations("landing.flowSlots");
  const slot = slots[idx];

  return (
    <div className="relative">
      <div
        className="relative overflow-hidden rounded-2xl"
        style={{
          border: `1px solid ${PAPER_RULE}`,
          background: PAPER,
          boxShadow:
            "inset 0 1px 0 rgba(255,255,255,0.7), 0 14px 28px -18px rgba(0,0,0,0.55)",
          minHeight: 76,
        }}
      >
        <AnimatePresence mode="wait">
          <motion.div
            key={slot.id}
            initial={{ opacity: 0, y: 8, filter: "blur(4px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{
              opacity: 0,
              transition: { duration: 0.12, ease: "easeOut" },
            }}
            transition={{ duration: 0.5, ease: EASE }}
            className="flex items-center justify-between gap-2 p-3 sm:gap-3 sm:p-4"
          >
            <FlowSlotIdentity label={label} slot={slot} />
            <div className="shrink-0 text-right">
              <div
                className="max-w-[100px] truncate font-mono text-[11px] tabular-nums sm:max-w-none"
                style={{ color: INK_60 }}
              >
                {tSlots(`${slot.id}.sub`)}
              </div>
              {tone === "success" && (
                <div
                  className="mt-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5"
                  style={{
                    background: "rgba(2,141,196,0.12)",
                    color: "#0369A1",
                  }}
                >
                  <Check className="h-2.5 w-2.5" strokeWidth={2.4} />
                  <span className="font-mono text-[9px] uppercase tracking-[0.2em]">
                    {tShowcase("emitted")}
                  </span>
                </div>
              )}
            </div>
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="mt-2 flex items-center justify-center gap-1.5">
        {slots.map((s, i) => (
          <span
            key={s.id}
            className="h-1 rounded-full transition-all duration-500"
            style={{
              width: i === idx ? 12 : 4,
              background: i === idx ? ACCENT : "rgba(255,255,255,0.16)",
              transitionTimingFunction: "cubic-bezier(0.32,0.72,0,1)",
            }}
          />
        ))}
      </div>
    </div>
  );
});

function FlowSlotIdentity({
  label,
  slot,
}: {
  label: string;
  slot: FlowSlot;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <BrandLogo slot={slot} width={72} height={32} logoH={18} hPad={10} />
      <div className="min-w-0">
        <div
          className="font-mono text-[10px] uppercase tracking-[0.18em]"
          style={{ color: INK_40 }}
        >
          {label}
        </div>
        <div
          className="truncate text-[14px] font-medium"
          style={{ color: INK }}
        >
          {slot.title}
        </div>
      </div>
    </div>
  );
}

function BrandLogo({
  slot,
  width,
  height,
  logoH,
  hPad = 12,
}: {
  slot: { logoSrc: string | null; mark?: string; brand?: string; title?: string; name?: string };
  width: number;
  height: number;
  logoH: number;
  hPad?: number;
}) {
  const alt = slot.title ?? slot.name ?? "";
  if (slot.logoSrc) {
    const logoW = Math.max(0, width - hPad * 2);
    return (
      <div
        className="flex shrink-0 items-center justify-center"
        style={{ width, height }}
      >
        <Image
          src={slot.logoSrc}
          alt={alt}
          width={logoW}
          height={logoH}
          className="object-contain"
          style={{ maxHeight: logoH, maxWidth: logoW, width: "auto" }}
        />
      </div>
    );
  }
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-lg font-mono font-medium"
      style={{
        width: height,
        height,
        background: slot.brand ?? INK,
        color: "#FFFFFF",
        letterSpacing: "-0.02em",
        fontSize: 13,
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.18)",
      }}
    >
      {slot.mark}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Engine card
// ─────────────────────────────────────────────────────────────
function EngineCard({ destIdx }: { destIdx: number }) {
  const t = useTranslations("landing.showcase");
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: EASE, delay: 0.9 }}
      className="relative rounded-2xl p-4"
      style={{
        background: "linear-gradient(135deg, #028DC4 0%, #0369A1 100%)",
        color: "#FFFFFF",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.15), 0 0 40px -10px rgba(2,141,196,0.55), 0 12px 30px -16px rgba(0,0,0,0.6)",
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
            style={{ background: "rgba(255,255,255,0.14)" }}
          >
            <Workflow className="h-4 w-4" strokeWidth={1.5} />
          </div>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium">
              {t("engineTitle")}
            </div>
            <div
              className="font-mono text-[10px] uppercase tracking-[0.18em]"
              style={{ color: "rgba(255,255,255,0.72)" }}
            >
              {t("engineSub")}
            </div>
          </div>
        </div>
        <div
          className="shrink-0 font-mono text-[10px] tabular-nums"
          style={{ color: "rgba(255,255,255,0.85)" }}
        >
          347 ms
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {PIPELINE_STEPS.map((step, i) => (
          <motion.div
            key={`${destIdx}-${step}`}
            initial={{ scale: 0.82, opacity: 0.35 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{
              type: "spring",
              stiffness: 220,
              damping: 14,
              delay: i * 0.07,
            }}
            className="flex items-center gap-1.5 rounded-md px-2 py-1"
            style={{ background: "rgba(255,255,255,0.14)" }}
          >
            <Check
              className="h-3 w-3"
              style={{ color: ACCENT_HOT }}
              strokeWidth={2.4}
            />
            <span
              className="font-mono text-[10px]"
              style={{ color: "rgba(255,255,255,0.95)" }}
            >
              {step}
            </span>
          </motion.div>
        ))}
      </div>
    </motion.div>
  );
}

function FlowConnector({ animated = false }: { animated?: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, scaleY: 0.4 }}
      animate={{ opacity: 1, scaleY: 1 }}
      transition={{ duration: 0.5, ease: EASE, delay: 0.7 }}
      className="my-2 flex items-center justify-center"
      style={{ transformOrigin: "center top" }}
    >
      <div
        className="h-6 w-px"
        style={{
          backgroundImage: `repeating-linear-gradient(180deg, ${ACCENT_HOT} 0 2px, transparent 2px 8px)`,
          backgroundSize: "1px 8px",
          animation: animated ? "rk-flow-down 0.9s linear infinite" : undefined,
        }}
      />
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────
// Integration matrix
// ─────────────────────────────────────────────────────────────
function IntegrationMatrix() {
  const t = useTranslations("landing.matrix");
  const pagamentos = INTEGRATIONS.filter((i) => i.kind === "pagamentos");
  const faturação = INTEGRATIONS.filter((i) => i.kind === "faturação");

  return (
    <section id="integracoes" className="relative px-4 pt-20 sm:pt-32 md:pt-44">
      <div className="mx-auto w-full max-w-[1280px]">
        <SectionHead
          eyebrow={t("eyebrow")}
          title={t.rich("title", RICH_ELEMENTS)}
          sub={t("sub")}
        />

        <IntegrationGroup
          kind={t("groupPayments")}
          subtitle={t("subtitlePayments")}
          items={pagamentos}
        />

        <div className="my-14 h-px w-full" style={{ background: RULE }} />

        <IntegrationGroup
          kind={t("groupInvoicing")}
          subtitle={t("subtitleInvoicing")}
          items={faturação}
        />

        <div
          className="mt-16 flex flex-wrap items-center justify-between gap-4 rounded-2xl px-5 py-4"
          style={{ ...GLASS }}
        >
          <div className="flex items-center gap-3">
            <Layers
              className="h-4 w-4"
              style={{ color: FG_60 }}
              strokeWidth={1.5}
            />
            <div>
              <div className="text-[13px]" style={{ color: FG }}>
                {t("missingTitle")}
              </div>
              <div
                className="font-mono text-[10px] uppercase tracking-[0.18em]"
                style={{ color: FG_40 }}
              >
                {t("missingSub")}
              </div>
            </div>
          </div>
          <a
            href={`mailto:rioko@kapta.pt?subject=${encodeURIComponent(t("missingEmailSubject"))}`}
            className="group inline-flex items-center gap-2 text-[13px]"
            style={{ color: FG }}
          >
            <span
              className="border-b"
              style={{ borderColor: "rgba(255,255,255,0.16)" }}
            >
              {t("missingCta")}
            </span>
            <ArrowUpRight
              className="h-3.5 w-3.5 transition-transform duration-500 group-hover:translate-x-[1px] group-hover:-translate-y-[1px]"
              strokeWidth={1.6}
            />
          </a>
        </div>
      </div>
    </section>
  );
}

function IntegrationGroup({
  kind,
  subtitle,
  items,
}: {
  kind: string;
  subtitle: string;
  items: Integration[];
}) {
  return (
    <div className="mt-12">
      <div className="mb-6 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
        <h3 className="text-[14px] font-medium" style={{ color: FG }}>
          {kind}
        </h3>
        <span
          className="font-mono text-[10px] uppercase tracking-[0.18em]"
          style={{ color: FG_40 }}
        >
          {subtitle}
        </span>
      </div>

      <motion.div
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, margin: "-80px" }}
        variants={{
          hidden: {},
          show: { transition: { staggerChildren: 0.06 } },
        }}
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
      >
        {items.map((it) => (
          <IntegrationCard key={it.id} item={it} />
        ))}
      </motion.div>
    </div>
  );
}

function IntegrationCard({ item }: { item: Integration }) {
  const tInt = useTranslations("landing.integrations");
  const isLive = item.status === "live";
  return (
    <motion.div
      variants={{
        hidden: { y: 14, opacity: 0, filter: "blur(4px)" },
        show: {
          y: 0,
          opacity: 1,
          filter: "blur(0px)",
          transition: { duration: 0.6, ease: EASE },
        },
      }}
      whileHover={{ y: -3, transition: { duration: 0.3, ease: EASE } }}
      className="group relative rounded-[1.25rem]"
    >
      <div
        className="relative h-full overflow-hidden rounded-[1.25rem] p-6 transition-all duration-500"
        style={{
          background: PAPER,
          border: `1px solid ${PAPER_RULE}`,
          boxShadow:
            "inset 0 1px 0 rgba(255,255,255,0.7), 0 18px 36px -22px rgba(0,0,0,0.45)",
          transitionTimingFunction: "cubic-bezier(0.32,0.72,0,1)",
        }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[1.25rem] opacity-0 transition-opacity duration-500 group-hover:opacity-100"
          style={{
            boxShadow: `inset 0 0 0 1px rgba(2,141,196,0.55)`,
            transitionTimingFunction: "cubic-bezier(0.32,0.72,0,1)",
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-px rounded-[1.25rem] opacity-0 transition-opacity duration-500 group-hover:opacity-100"
          style={{ boxShadow: "0 18px 50px -20px rgba(2,141,196,0.35)" }}
        />

        <div className="relative flex items-start justify-between gap-3">
          <BrandLogo
            slot={{
              logoSrc: item.logoSrc ?? null,
              mark: item.mark,
              brand: item.brand,
              title: item.name,
            }}
            width={132}
            height={48}
            logoH={26}
            hPad={20}
          />
          <StatusBadge status={item.status} />
        </div>

        <div className="relative mt-6">
          <div
            className="text-[18px] font-medium tracking-tight"
            style={{ color: INK }}
          >
            {item.name}
          </div>
          <div
            className="mt-1 text-[13px] leading-[1.45]"
            style={{ color: INK_60 }}
          >
            {tInt(`${item.id}.note`)}
          </div>
        </div>

        {!isLive && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-[1.25rem]"
            style={{
              backgroundImage:
                "repeating-linear-gradient(135deg, rgba(20,24,31,0.06) 0 6px, transparent 6px 14px)",
            }}
          />
        )}
      </div>
    </motion.div>
  );
}

function StatusBadge({ status }: { status: Status }) {
  const t = useTranslations("landing.status");
  const styles: Record<Status, React.CSSProperties> = {
    live: { background: "rgba(2,141,196,0.12)", color: "#0369A1" },
    soon: { background: "rgba(154,106,31,0.14)", color: "#7C4A0F" },
    planned: { background: "rgba(20,24,31,0.08)", color: INK_60 },
  };
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em]"
      style={styles[status]}
    >
      {status === "live" && (
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: "#0369A1" }}
        />
      )}
      {t(status)}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────
// How it works
// ─────────────────────────────────────────────────────────────
function HowItWorks() {
  const t = useTranslations("landing.how");

  const steps: StepData[] = [
    {
      n: "01",
      icon: Plug,
      title: t("step1.title"),
      body: t("step1.body"),
      code: [
        t("step1.code1"),
        t("step1.code2"),
        t("step1.code3"),
        t("step1.code4"),
      ],
    },
    {
      n: "02",
      icon: ScrollText,
      title: t("step2.title"),
      body: t("step2.body"),
      pills: [
        t("step2.pill1"),
        t("step2.pill2"),
        t("step2.pill3"),
        t("step2.pill4"),
      ],
    },
    {
      n: "03",
      icon: FileText,
      title: t("step3.title"),
      body: t("step3.body"),
      ticks: [t("step3.tick1"), t("step3.tick2"), t("step3.tick3")],
      tagD1: t("step3.tagD1"),
      tagKV: t("step3.tagKV"),
      tagHMAC: t("step3.tagHMAC"),
    },
  ];

  return (
    <section id="como-funciona" className="relative px-4 pt-20 sm:pt-32 md:pt-44">
      <div className="mx-auto w-full max-w-[1280px]">
        <SectionHead
          eyebrow={t("eyebrow")}
          title={t.rich("title", RICH_ELEMENTS)}
          sub={t("sub")}
        />

        <div className="mt-16 space-y-20">
          {steps.map((s, i) => (
            <Step key={s.n} step={s} flip={i % 2 === 1} stepLabel={t("stepLabel")} />
          ))}
        </div>
      </div>
    </section>
  );
}

type StepData = {
  n: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  title: string;
  body: string;
  code?: string[];
  pills?: string[];
  ticks?: string[];
  tagD1?: string;
  tagKV?: string;
  tagHMAC?: string;
};

function Step({
  step,
  flip,
  stepLabel,
}: {
  step: StepData;
  flip: boolean;
  stepLabel: string;
}) {
  const Icon = step.icon;
  return (
    <motion.div
      initial={{ opacity: 0, y: 24, filter: "blur(6px)" }}
      whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      transition={{ duration: 0.8, ease: EASE }}
      viewport={{ once: true, margin: "-100px" }}
      className="grid grid-cols-1 items-center gap-10 md:grid-cols-12 md:gap-12"
    >
      <div className={"md:col-span-6 " + (flip ? "md:order-2" : "")}>
        <div className="flex items-center gap-3">
          <span
            className="font-mono text-[11px] uppercase tracking-[0.24em]"
            style={{ color: FG_40 }}
          >
            {stepLabel} {step.n}
          </span>
          <span className="h-px flex-1" style={{ background: RULE }} />
        </div>
        <h3
          className="mt-5 tracking-[-0.025em]"
          style={{
            fontFamily: "var(--font-sans-display), system-ui, sans-serif",
            fontSize: "clamp(2rem, 3.4vw, 3rem)",
            lineHeight: 1.02,
            color: FG,
            fontWeight: 500,
          }}
        >
          {step.title}
        </h3>
        <p
          className="mt-5 max-w-[52ch] text-[15px] leading-[1.6]"
          style={{ color: FG_60 }}
        >
          {step.body}
        </p>

        {step.ticks && (
          <ul className="mt-6 space-y-2.5">
            {step.ticks.map((t) => (
              <li
                key={t}
                className="flex items-start gap-2.5 text-[14px]"
                style={{ color: FG }}
              >
                <span
                  className="mt-1.5 inline-flex h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: ACCENT_HOT }}
                />
                {t}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={"md:col-span-6 " + (flip ? "md:order-1" : "")}>
        <div
          className="rounded-[1.75rem] p-1.5"
          style={{ background: "rgba(255,255,255,0.04)" }}
        >
          <div
            className="overflow-hidden rounded-[calc(1.75rem-0.375rem)] p-6"
            style={{ ...GLASS, background: "rgba(20,24,31,0.7)" }}
          >
            <div className="flex items-center justify-between">
              <div
                className="flex h-10 w-10 items-center justify-center rounded-xl"
                style={{
                  background: "rgba(255,255,255,0.04)",
                  border: `1px solid ${HAIRLINE}`,
                  color: FG,
                }}
              >
                <Icon className="h-4 w-4" strokeWidth={1.5} />
              </div>
              <span
                className="font-mono text-[10px] uppercase tracking-[0.18em]"
                style={{ color: FG_40 }}
              >
                {step.n}
              </span>
            </div>

            {step.code && (
              <div className="mt-6">
                <div
                  className="flex items-center justify-between rounded-t-xl px-3 py-2"
                  style={{
                    background: "rgba(0,0,0,0.4)",
                    border: `1px solid ${HAIRLINE}`,
                    borderBottom: "none",
                  }}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ background: "rgba(255,255,255,0.18)" }} />
                    <span className="h-2 w-2 rounded-full" style={{ background: "rgba(255,255,255,0.18)" }} />
                    <span className="h-2 w-2 rounded-full" style={{ background: "rgba(255,255,255,0.18)" }} />
                  </div>
                  <span
                    className="font-mono text-[10px] uppercase tracking-[0.18em]"
                    style={{ color: FG_40 }}
                  >
                    activate.sh
                  </span>
                  <span className="w-8" />
                </div>
                <pre
                  className="overflow-x-auto rounded-b-xl p-4 font-mono text-[11px] leading-[1.6] sm:text-[12px]"
                  style={{
                    background: "rgba(0,0,0,0.5)",
                    border: `1px solid ${HAIRLINE}`,
                    borderTop: "none",
                    color: FG,
                  }}
                >
                  {step.code.map((line, i) => (
                    <div
                      key={i}
                      style={{
                        color:
                          i === 0
                            ? ACCENT
                            : i === step.code!.length - 1
                            ? ACCENT_HOT
                            : "rgba(240,240,240,0.85)",
                      }}
                    >
                      {line}
                    </div>
                  ))}
                </pre>
              </div>
            )}

            {step.pills && (
              <div className="mt-6 flex flex-wrap gap-2">
                {step.pills.map((p) => (
                  <span
                    key={p}
                    className="rounded-full px-3 py-1.5 text-[12px] font-mono"
                    style={{
                      border: `1px solid ${HAIRLINE}`,
                      background: "rgba(255,255,255,0.03)",
                      color: FG,
                    }}
                  >
                    {p}
                  </span>
                ))}
              </div>
            )}

            {step.ticks && (
              <div
                className="mt-6 grid grid-cols-3 gap-2 border-t pt-4"
                style={{ borderColor: HAIRLINE }}
              >
                {[
                  { key: "D1", label: step.tagD1 },
                  { key: "KV", label: step.tagKV },
                  { key: "HMAC", label: step.tagHMAC },
                ].map((tag, i) => (
                  <div
                    key={tag.key}
                    className="rounded-lg px-2 py-3 text-center"
                    style={{
                      background:
                        i === 0
                          ? "rgba(2,141,196,0.10)"
                          : "rgba(255,255,255,0.03)",
                      border:
                        i === 0
                          ? `1px solid rgba(2,141,196,0.35)`
                          : `1px solid ${HAIRLINE}`,
                    }}
                  >
                    <div
                      className="font-mono text-[11px]"
                      style={{ color: i === 0 ? ACCENT_HOT : FG }}
                    >
                      {tag.key}
                    </div>
                    <div
                      className="mt-1 font-mono text-[9px] uppercase tracking-[0.18em]"
                      style={{ color: FG_40 }}
                    >
                      {tag.label}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────
// Fiscal trust
// ─────────────────────────────────────────────────────────────
function FiscalTrust() {
  const t = useTranslations("landing.fiscal");
  const items = [
    { icon: ShieldCheck, title: t("item1Title"), body: t("item1Body") },
    { icon: ScrollText, title: t("item2Title"), body: t("item2Body") },
    { icon: Workflow, title: t("item3Title"), body: t("item3Body") },
    { icon: Layers, title: t("item4Title"), body: t("item4Body") },
  ];

  return (
    <section id="fiscal" className="relative px-4 pt-20 sm:pt-32 md:pt-44">
      <div className="mx-auto w-full max-w-[1280px]">
        <SectionHead
          eyebrow={t("eyebrow")}
          title={t.rich("title", RICH_ELEMENTS)}
          sub={t("sub")}
        />

        <div
          className="mt-14 grid grid-cols-1 gap-px overflow-hidden rounded-[1.75rem] md:grid-cols-2"
          style={{
            border: `1px solid ${HAIRLINE}`,
            background: RULE,
          }}
        >
          {items.map((it) => (
            <div
              key={it.title}
              className="p-8 md:p-10"
              style={{ background: SURFACE }}
            >
              <it.icon
                className="h-5 w-5"
                style={{ color: ACCENT_HOT }}
                strokeWidth={1.5}
              />
              <h4
                className="mt-5 text-[18px] font-medium tracking-tight"
                style={{ color: FG }}
              >
                {it.title}
              </h4>
              <p
                className="mt-2 max-w-[42ch] text-[14px] leading-[1.55]"
                style={{ color: FG_60 }}
              >
                {it.body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Pricing
// ─────────────────────────────────────────────────────────────
function Pricing() {
  const t = useTranslations("landing.pricing");

  const tiers: Tier[] = [
    {
      id: "monthly",
      name: t("monthly.name"),
      cadence: t("monthly.cadence"),
      price: "7,50",
      currency: "€",
      period: t("monthly.period"),
      tagline: t("monthly.tagline"),
      bullets: [
        t("monthly.b1"),
        t("monthly.b2"),
        t("monthly.b3"),
        t("monthly.b4"),
        t("monthly.b5"),
      ],
      cta: { label: t("monthly.cta"), href: "/sign-up", external: false },
      highlight: false,
    },
    {
      id: "yearly",
      name: t("yearly.name"),
      cadence: t("yearly.cadence"),
      price: "75",
      currency: "€",
      period: t("yearly.period"),
      tagline: t("yearly.tagline"),
      savings: t("yearly.savings"),
      bullets: [
        t("yearly.b1"),
        t("yearly.b2"),
        t("yearly.b3"),
        t("yearly.b4"),
      ],
      cta: { label: t("yearly.cta"), href: "/sign-up", external: false },
      highlight: true,
    },
    {
      id: "custom",
      name: t("custom.name"),
      cadence: t("custom.cadence"),
      price: t("custom.priceLabel"),
      currency: "",
      period: t("custom.period"),
      tagline: t("custom.tagline"),
      bullets: [
        t("custom.b1"),
        t("custom.b2"),
        t("custom.b3"),
        t("custom.b4"),
      ],
      cta: { label: t("custom.cta"), href: "https://kapta.pt/", external: true },
      highlight: false,
    },
  ];

  return (
    <section id="preco" className="relative px-4 pt-20 sm:pt-32 md:pt-44">
      <div className="mx-auto w-full max-w-[1280px]">
        <SectionHead
          eyebrow={t("eyebrow")}
          title={t.rich("title", RICH_ELEMENTS)}
          sub={t("sub")}
        />

        <div className="mt-14 grid grid-cols-1 gap-8 md:grid-cols-3 md:gap-4">
          {tiers.map((tier) => (
            <PricingCard key={tier.id} tier={tier} recommendedLabel={t("recommended")} />
          ))}
        </div>

        <p
          className="mt-8 text-center font-mono text-[11px] uppercase tracking-[0.2em]"
          style={{ color: FG_40 }}
        >
          {t("notice")}
        </p>
      </div>
    </section>
  );
}

type Tier = {
  id: string;
  name: string;
  cadence: string;
  price: string;
  currency: string;
  period: string;
  tagline: string;
  savings?: string;
  bullets: string[];
  cta: { label: string; href: string; external: boolean };
  highlight: boolean;
};

function PricingCard({
  tier,
  recommendedLabel,
}: {
  tier: Tier;
  recommendedLabel: string;
}) {
  const isHighlight = tier.highlight;

  return (
    <motion.div
      initial={{ opacity: 0, y: 18, filter: "blur(4px)" }}
      whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.7, ease: EASE }}
      whileHover={{ y: -3, transition: { duration: 0.3, ease: EASE } }}
      className="relative"
    >
      {isHighlight && (
        <div
          className="absolute -top-3 left-1/2 z-10 -translate-x-1/2 rounded-full px-3 py-1 font-mono text-[10px] uppercase tracking-[0.22em]"
          style={{
            background: ACCENT,
            color: "#FFFFFF",
            boxShadow: "0 10px 24px -10px rgba(2,141,196,0.6)",
          }}
        >
          {recommendedLabel}
        </div>
      )}

      <div
        className="relative h-full overflow-hidden rounded-[1.5rem] p-6 sm:p-8 transition-all duration-500"
        style={
          isHighlight
            ? {
                background:
                  "linear-gradient(180deg, rgba(2,141,196,0.10) 0%, rgba(2,141,196,0.02) 100%)",
                border: `1px solid rgba(2,141,196,0.35)`,
                boxShadow:
                  "inset 0 1px 0 rgba(255,255,255,0.08), 0 24px 60px -24px rgba(2,141,196,0.45)",
              }
            : {
                ...GLASS,
                background: "rgba(20,24,31,0.55)",
              }
        }
      >
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-[14px] font-medium" style={{ color: FG }}>
            {tier.name}
          </div>
          <span
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: FG_40 }}
          >
            {tier.cadence}
          </span>
        </div>

        <div className="mt-6 flex items-baseline gap-1">
          <span
            className="tracking-[-0.03em]"
            style={{
              fontFamily: "var(--font-sans-display), system-ui, sans-serif",
              fontSize: "clamp(2.5rem, 4vw, 3.5rem)",
              fontWeight: 500,
              color: FG,
              lineHeight: 1,
            }}
          >
            {tier.price}
          </span>
          {tier.currency && (
            <span
              className="text-[28px] font-medium"
              style={{ color: FG, lineHeight: 1 }}
            >
              {tier.currency}
            </span>
          )}
          <span className="ml-1 text-[12px]" style={{ color: FG_60 }}>
            {tier.period}
          </span>
        </div>

        {tier.savings && (
          <div
            className="mt-3 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1"
            style={{
              background: "rgba(94,234,212,0.10)",
              color: ACCENT_HOT,
            }}
          >
            <Sparkle className="h-3 w-3" strokeWidth={2} />
            <span className="font-mono text-[10px] uppercase tracking-[0.18em]">
              {tier.savings}
            </span>
          </div>
        )}

        <p
          className="mt-5 text-[14px] leading-[1.55]"
          style={{ color: FG_60 }}
        >
          {tier.tagline}
        </p>

        <ul className="mt-6 space-y-2.5">
          {tier.bullets.map((b) => (
            <li
              key={b}
              className="flex items-start gap-2.5 text-[13px]"
              style={{ color: FG }}
            >
              <Check
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
                style={{ color: ACCENT_HOT }}
                strokeWidth={2.2}
              />
              {b}
            </li>
          ))}
        </ul>

        <div className="mt-8">
          {tier.cta.external ? (
            <a
              href={tier.cta.href}
              target="_blank"
              rel="noopener noreferrer"
              className="group inline-flex w-full items-center justify-between gap-2 rounded-full py-3 pl-5 pr-2 text-[13px] font-medium transition-transform duration-500 active:scale-[0.98]"
              style={{
                background: isHighlight ? ACCENT : FG,
                color: isHighlight ? "#FFFFFF" : SURFACE,
                transitionTimingFunction: "cubic-bezier(0.32,0.72,0,1)",
                boxShadow: isHighlight
                  ? "0 14px 30px -10px rgba(2,141,196,0.55)"
                  : "0 14px 30px -16px rgba(0,0,0,0.5)",
              }}
            >
              {tier.cta.label}
              <span
                className="flex h-7 w-7 items-center justify-center rounded-full transition-transform duration-500 group-hover:translate-x-[2px] group-hover:-translate-y-[1px]"
                style={{
                  background: isHighlight
                    ? "rgba(255,255,255,0.18)"
                    : "rgba(0,0,0,0.08)",
                  transitionTimingFunction: "cubic-bezier(0.32,0.72,0,1)",
                }}
              >
                <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.6} />
              </span>
            </a>
          ) : (
            <Link
              href={tier.cta.href}
              className="group inline-flex w-full items-center justify-between gap-2 rounded-full py-3 pl-5 pr-2 text-[13px] font-medium transition-transform duration-500 active:scale-[0.98]"
              style={{
                background: isHighlight ? ACCENT : FG,
                color: isHighlight ? "#FFFFFF" : SURFACE,
                transitionTimingFunction: "cubic-bezier(0.32,0.72,0,1)",
                boxShadow: isHighlight
                  ? "0 14px 30px -10px rgba(2,141,196,0.55)"
                  : "0 14px 30px -16px rgba(0,0,0,0.5)",
              }}
            >
              {tier.cta.label}
              <span
                className="flex h-7 w-7 items-center justify-center rounded-full transition-transform duration-500 group-hover:translate-x-[2px] group-hover:-translate-y-[1px]"
                style={{
                  background: isHighlight
                    ? "rgba(255,255,255,0.18)"
                    : "rgba(0,0,0,0.08)",
                  transitionTimingFunction: "cubic-bezier(0.32,0.72,0,1)",
                }}
              >
                <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.6} />
              </span>
            </Link>
          )}
        </div>
      </div>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────
// Final CTA
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// FAQ — answer-first Q&A; FAQPage JSON-LD is emitted server-side in page.tsx
// ─────────────────────────────────────────────────────────────
function Faq() {
  const t = useTranslations("landing.faq");
  const items = t.raw("items") as Array<{ q: string; a: string }>;
  const [open, setOpen] = useState<number | null>(0);

  return (
    <section id="faq" className="relative px-4 pt-20 sm:pt-32 md:pt-44">
      <div className="mx-auto w-full max-w-[1280px]">
        <SectionHead
          eyebrow={t("eyebrow")}
          title={t.rich("title", RICH_ELEMENTS)}
          sub={t("sub")}
        />

        <div className="mx-auto mt-14 max-w-[820px]">
          {items.map((item, i) => {
            const isOpen = open === i;
            return (
              <div
                key={i}
                className="border-t first:border-t-0"
                style={{ borderColor: HAIRLINE }}
              >
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? null : i)}
                  aria-expanded={isOpen}
                  className="flex w-full items-center justify-between gap-6 py-6 text-left transition-opacity hover:opacity-90"
                >
                  <span
                    data-faq-question
                    className="text-[16px] font-medium tracking-tight sm:text-[18px]"
                    style={{ color: FG }}
                  >
                    {item.q}
                  </span>
                  <ChevronDown
                    className="h-5 w-5 shrink-0 transition-transform duration-300"
                    style={{
                      color: ACCENT_HOT,
                      transform: isOpen ? "rotate(180deg)" : "none",
                    }}
                    strokeWidth={1.6}
                  />
                </button>
                <AnimatePresence initial={false}>
                  {isOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.3, ease: EASE }}
                      className="overflow-hidden"
                    >
                      <p
                        data-faq-answer
                        className="max-w-[68ch] pb-6 text-[14px] leading-[1.6]"
                        style={{ color: FG_60 }}
                      >
                        {item.a}
                      </p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Final CTA
// ─────────────────────────────────────────────────────────────
function FinalCTA() {
  const t = useTranslations("landing.cta");
  return (
    <section className="relative px-4 pt-20 pb-16 sm:pt-32 sm:pb-24 md:pt-44 md:pb-32">
      <div className="mx-auto w-full max-w-[1280px]">
        <div
          className="relative overflow-hidden rounded-[2rem] p-1.5"
          style={{ background: "rgba(2,141,196,0.18)" }}
        >
          <div
            className="relative overflow-hidden rounded-[calc(2rem-0.375rem)] px-6 py-12 sm:px-8 sm:py-16 md:px-16 md:py-24"
            style={{
              background:
                "linear-gradient(135deg, #0A0A0A 0%, #14181F 60%, #0A2540 100%)",
              color: FG,
              boxShadow:
                "inset 0 1px 0 rgba(255,255,255,0.06), inset 0 0 0 1px rgba(2,141,196,0.18)",
            }}
          >
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{
                backgroundImage:
                  "radial-gradient(50% 60% at 20% 0%, rgba(2,141,196,0.18), transparent 60%), radial-gradient(40% 50% at 90% 100%, rgba(94,234,212,0.10), transparent 60%)",
              }}
            />

            <div className="relative grid grid-cols-1 items-end gap-10 md:grid-cols-12 md:gap-10">
              <div className="md:col-span-7">
                <span
                  className="font-mono text-[10px] uppercase tracking-[0.22em]"
                  style={{ color: "rgba(240,240,240,0.55)" }}
                >
                  {t("eyebrow")}
                </span>
                <h2
                  className="mt-4 tracking-[-0.025em]"
                  style={{
                    fontFamily:
                      "var(--font-sans-display), system-ui, sans-serif",
                    fontSize: "clamp(2.5rem, 5vw, 4.75rem)",
                    lineHeight: 0.98,
                    fontWeight: 500,
                  }}
                >
                  {t.rich("title", RICH_ELEMENTS)}
                </h2>
              </div>
              <div className="md:col-span-5">
                <p
                  className="mb-7 max-w-[40ch] text-[15px] leading-[1.55]"
                  style={{ color: "rgba(240,240,240,0.7)" }}
                >
                  {t("body")}
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  <Link
                    href="/sign-up"
                    className="group inline-flex items-center gap-2 rounded-full py-3 pl-6 pr-2 text-[14px] font-medium transition-transform duration-500 active:scale-[0.98]"
                    style={{
                      background: ACCENT,
                      color: "#FFFFFF",
                      transitionTimingFunction:
                        "cubic-bezier(0.32,0.72,0,1)",
                      boxShadow:
                        "0 1px 0 rgba(255,255,255,0.18) inset, 0 14px 30px -10px rgba(2,141,196,0.55)",
                    }}
                  >
                    {t("start")}
                    <span
                      className="flex h-8 w-8 items-center justify-center rounded-full transition-transform duration-500 group-hover:translate-x-[2px] group-hover:-translate-y-[1px]"
                      style={{
                        background: "rgba(255,255,255,0.16)",
                        transitionTimingFunction:
                          "cubic-bezier(0.32,0.72,0,1)",
                      }}
                    >
                      <ArrowUpRight className="h-4 w-4" strokeWidth={1.6} />
                    </span>
                  </Link>
                  <Link
                    href="/sign-in"
                    className="text-[14px]"
                    style={{ color: "rgba(240,240,240,0.8)" }}
                  >
                    <span
                      className="border-b"
                      style={{ borderColor: "rgba(240,240,240,0.25)" }}
                    >
                      {t("signIn")}
                    </span>
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Footer
// ─────────────────────────────────────────────────────────────
function Footer() {
  const t = useTranslations("landing.footer");
  return (
    <footer
      className="relative border-t px-4 pb-12 pt-12"
      style={{ borderColor: RULE }}
    >
      <div className="mx-auto flex w-full max-w-[1280px] flex-col items-center gap-6 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-col items-center gap-2 sm:flex-row sm:gap-3">
          <Image
            src="/images/rioko2-logo.svg"
            alt="Rioko 2.0"
            width={110}
            height={23}
          />
          <span
            className="font-mono text-[10px] uppercase tracking-[0.2em]"
            style={{ color: FG_40 }}
          >
            {t("rights", { year: new Date().getFullYear() })}
          </span>
        </div>

        <div className="flex items-center gap-6">
          <Link
            href="/privacy"
            className="text-[12px]"
            style={{ color: FG_60 }}
          >
            {t("privacy")}
          </Link>
          <Link href="/terms" className="text-[12px]" style={{ color: FG_60 }}>
            {t("terms")}
          </Link>
          <button
            type="button"
            onClick={() =>
              window.dispatchEvent(new Event("rioko:open-consent"))
            }
            className="text-[12px] transition hover:opacity-80"
            style={{ color: FG_60 }}
          >
            {t("cookies")}
          </button>
        </div>

        <div className="flex flex-col items-center gap-3">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: FG_40 }}
          >
            {t("developedBy")}
          </div>
          <a
            href="https://kapta.pt"
            target="_blank"
            rel="noopener noreferrer"
            className="transition-transform duration-500 hover:scale-[1.05] active:scale-95"
            style={{
              transitionTimingFunction: "cubic-bezier(0.32,0.72,0,1)",
            }}
          >
            <Image
              src="/images/logo-kapta-white.webp"
              alt="Kapta"
              width={80}
              height={22}
              className="opacity-80 transition-opacity duration-500 hover:opacity-100"
            />
          </a>
        </div>
      </div>
    </footer>
  );
}

// ─────────────────────────────────────────────────────────────
// Section head
// ─────────────────────────────────────────────────────────────
function SectionHead({
  eyebrow,
  title,
  sub,
}: {
  eyebrow: string;
  title: React.ReactNode;
  sub: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-8 md:grid-cols-12">
      <div className="md:col-span-5">
        <span
          className="inline-flex items-center gap-2 rounded-full px-3 py-1 font-mono text-[10px] uppercase tracking-[0.22em]"
          style={{
            border: `1px solid ${RULE}`,
            color: FG_60,
            background: "rgba(255,255,255,0.02)",
          }}
        >
          <span
            className="h-1 w-1 rounded-full"
            style={{ background: ACCENT_HOT }}
          />
          {eyebrow}
        </span>
        <h2
          className="mt-6 tracking-[-0.025em]"
          style={{
            fontFamily: "var(--font-sans-display), system-ui, sans-serif",
            fontSize: "clamp(2.25rem, 4vw, 3.75rem)",
            lineHeight: 1.02,
            color: FG,
            fontWeight: 500,
          }}
        >
          {title}
        </h2>
      </div>
      <div className="md:col-span-6 md:col-start-7">
        <p
          className="max-w-[52ch] text-[15px] leading-[1.6] md:mt-14"
          style={{ color: FG_60 }}
        >
          {sub}
        </p>
      </div>
    </div>
  );
}

// Mono helper kept for potential future use
export { Mono };
