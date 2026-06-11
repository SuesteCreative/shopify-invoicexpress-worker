"use client";

/**
 * /shopify landing — "Midnight Ledger" design.
 *
 * Visual identity intentionally distinct from the hub landing (Landing.tsx):
 * the invoice document itself is the hero. A live FT document issues itself
 * on loop (webhook → fields type in → IVA computed → ATCUD stamped), backed
 * by a fiscal-artifact ticker, an audit-log timeline, ledger-row trust items,
 * a thermal-receipt pricing card and a stamp CTA.
 *
 * Fonts: Bricolage Grotesque (display) + IBM Plex Mono (ledger) — scoped via
 * app/[locale]/shopify/fonts.ts. Body inherits Geist from the locale layout.
 */

import * as React from "react";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { motion, AnimatePresence, useReducedMotion, animate } from "framer-motion";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import {
  ArrowUpRight,
  ArrowRight,
  Check,
  Plus,
  ShieldCheck,
} from "lucide-react";
import { LangToggle } from "./LangToggle";

// ─────────────────────────────────────────────────────────────
// Tokens — Midnight Ledger
// ─────────────────────────────────────────────────────────────
const BG = "#07090C";
const PANEL = "#0D1117";
const FG = "#EDEFF2";
const DIM = "rgba(237,239,242,0.58)";
const FAINT = "rgba(237,239,242,0.34)";
const LINE = "rgba(237,239,242,0.10)";
const LINE_SOFT = "rgba(237,239,242,0.06)";

const CYAN = "#2FB9F0"; // electric read of the brand cyan on near-black
const CYAN_DEEP = "#028DC4"; // brand
const MINT = "#5EEAD4"; // stamp / success only

const PAPER = "#F4F1EA";
const PAPER_EDGE = "rgba(24,28,34,0.10)";
const INK = "#181C22";
const INK_DIM = "rgba(24,28,34,0.60)";
const INK_FAINT = "rgba(24,28,34,0.38)";

const DISPLAY = "var(--font-ledger-display), var(--font-sans-display), sans-serif";
const MONO = "var(--font-ledger-mono), ui-monospace, monospace";

const EASE: [number, number, number, number] = [0.22, 0.8, 0.2, 1];

// ─────────────────────────────────────────────────────────────
// Rich-text map for t.rich()
// ─────────────────────────────────────────────────────────────
const RICH = {
  g: (chunks: React.ReactNode) => (
    <span style={{ color: CYAN }}>{chunks}</span>
  ),
  h: (chunks: React.ReactNode) => (
    <span
      style={{
        color: FG,
        boxShadow: `inset 0 -0.45em 0 rgba(2,141,196,0.32)`,
      }}
    >
      {chunks}
    </span>
  ),
  br: () => <br />,
  muted: (chunks: React.ReactNode) => (
    <span style={{ color: FAINT }}>{chunks}</span>
  ),
} as const;

const DESTINATIONS = [
  { id: "ix", name: "InvoiceXpress", logo: "/images/invoicexpress-logo.svg" },
  { id: "moloni", name: "Moloni", logo: "/images/moloni-logo.svg" },
  { id: "vendus", name: "Vendus", logo: "/images/vendus-logo.svg" },
] as const;

// ─────────────────────────────────────────────────────────────
// Root
// ─────────────────────────────────────────────────────────────
export default function ShopifyLanding() {
  useEffect(() => {
    const prev = {
      bg: document.body.style.backgroundColor,
      color: document.body.style.color,
    };
    document.body.style.backgroundColor = BG;
    document.body.style.color = FG;
    return () => {
      document.body.style.backgroundColor = prev.bg;
      document.body.style.color = prev.color;
    };
  }, []);

  return (
    <div
      className="relative min-h-[100dvh] w-full overflow-x-hidden"
      style={{ backgroundColor: BG, color: FG }}
    >
      <style>{`
        @keyframes rl-marquee {
          from { transform: translateX(0); }
          to   { transform: translateX(-50%); }
        }
        @keyframes rl-caret {
          0%, 49% { opacity: 1; }
          50%, 100% { opacity: 0; }
        }
        @keyframes rl-dash {
          to { stroke-dashoffset: -14; }
        }
        @media (prefers-reduced-motion: reduce) {
          .rl-marquee-track { animation: none !important; }
        }
      `}</style>

      {/* ledger grid atmosphere */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 z-0 h-[1200px]"
        style={{
          backgroundImage: `linear-gradient(${LINE_SOFT} 1px, transparent 1px),
                            linear-gradient(90deg, ${LINE_SOFT} 1px, transparent 1px)`,
          backgroundSize: "56px 56px",
          maskImage:
            "radial-gradient(80% 60% at 50% 0%, black 30%, transparent 100%)",
          WebkitMaskImage:
            "radial-gradient(80% 60% at 50% 0%, black 30%, transparent 100%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0"
        style={{
          backgroundImage: `radial-gradient(50% 38% at 82% 0%, rgba(2,141,196,0.13), transparent 65%),
                            radial-gradient(40% 30% at 0% 30%, rgba(2,141,196,0.06), transparent 60%)`,
        }}
      />

      <TopBar />

      <main className="relative z-10">
        <Hero />
        <Ticker />
        <Destinations />
        <AuditLog />
        <LedgerRows />
        <Receipt />
        <Faq />
        <StampCTA />
        <FooterSlim />
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Top bar
// ─────────────────────────────────────────────────────────────
function TopBar() {
  const t = useTranslations("shopifyLanding.nav");
  const tHub = useTranslations("landing.nav");

  const links = [
    { href: "#como-funciona", label: t("how") },
    { href: "#destinos", label: t("destinations") },
    { href: "#preco", label: t("pricing") },
    { href: "#faq", label: t("faq") },
  ];

  return (
    <header
      className="relative z-50 border-b"
      style={{ borderColor: LINE_SOFT }}
    >
      <div className="mx-auto flex w-full max-w-[1200px] items-center justify-between gap-4 px-4 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/" aria-label="Rioko">
            <Image
              src="/images/rioko2-logo.svg"
              alt="Rioko"
              width={104}
              height={22}
              priority
              className="h-auto w-[92px] sm:w-[104px]"
            />
          </Link>
          <span
            className="hidden items-center gap-2 sm:inline-flex"
            style={{ color: FAINT, fontFamily: MONO }}
          >
            <span aria-hidden style={{ color: CYAN }}>/</span>
            <span className="text-[10px] uppercase tracking-[0.22em]">
              {t("chip")}
            </span>
          </span>
        </div>

        <nav className="hidden items-center gap-6 lg:flex">
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="text-[11px] uppercase tracking-[0.18em] transition-colors duration-300 hover:text-[#EDEFF2]"
              style={{ color: DIM, fontFamily: MONO }}
            >
              {l.label}
            </a>
          ))}
          <Link
            href="/"
            className="text-[11px] uppercase tracking-[0.18em] transition-colors duration-300"
            style={{ color: FAINT, fontFamily: MONO }}
          >
            {t("hub")} ↗
          </Link>
        </nav>

        <div className="flex items-center gap-2">
          <div className="hidden sm:inline-flex">
            <LangToggle variant="dark" />
          </div>
          <Link
            href="/sign-in"
            className="hidden px-3 py-2 text-[13px] md:inline-block"
            style={{ color: DIM }}
          >
            {tHub("signIn")}
          </Link>
          <Link
            href="/sign-up"
            className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-[13px] font-medium transition-transform duration-300 active:scale-[0.97]"
            style={{
              background: CYAN_DEEP,
              color: "#FFFFFF",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.2)",
            }}
          >
            {tHub("start")}
            <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.75} />
          </Link>
        </div>
      </div>
    </header>
  );
}

// ─────────────────────────────────────────────────────────────
// Hero — headline overlapping the live invoice
// ─────────────────────────────────────────────────────────────
function Hero() {
  const t = useTranslations("shopifyLanding.hero");

  return (
    <section className="relative px-4 pt-16 md:pt-24">
      <div className="mx-auto grid w-full max-w-[1200px] grid-cols-1 items-start gap-14 lg:grid-cols-12 lg:gap-0">
        <div className="relative z-10 lg:col-span-7 lg:pr-2">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, ease: EASE }}
            className="inline-flex items-center gap-2 border px-3 py-1.5"
            style={{ borderColor: LINE, color: DIM }}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: MINT }}
            />
            <span
              className="text-[10px] uppercase tracking-[0.24em]"
              style={{ fontFamily: MONO }}
            >
              {t("chip")}
            </span>
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 22 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: EASE, delay: 0.08 }}
            className="mt-8"
            style={{
              fontFamily: DISPLAY,
              fontWeight: 600,
              fontSize: "clamp(2.9rem, 7vw, 6rem)",
              lineHeight: 0.96,
              letterSpacing: "-0.03em",
              textWrap: "balance" as const,
            }}
          >
            {t.rich("h1", RICH)}
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease: EASE, delay: 0.22 }}
            className="mt-7 max-w-[50ch] text-[16px] leading-[1.6]"
            style={{ color: DIM }}
          >
            {t.rich("body", RICH)}
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease: EASE, delay: 0.34 }}
            className="mt-10 flex flex-wrap items-center gap-5"
          >
            <Link
              href="/sign-up"
              className="group inline-flex items-center gap-3 px-6 py-3.5 text-[14px] font-medium transition-transform duration-300 active:scale-[0.97]"
              style={{
                background: FG,
                color: INK,
                boxShadow: "0 18px 40px -18px rgba(0,0,0,0.8)",
              }}
            >
              {t("ctaCreate")}
              <ArrowRight
                className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1"
                strokeWidth={1.75}
              />
            </Link>
            <a
              href="#como-funciona"
              className="group inline-flex items-center gap-2 text-[14px]"
              style={{ color: FG }}
            >
              <span
                className="border-b pb-0.5"
                style={{ borderColor: "rgba(47,185,240,0.4)" }}
              >
                {t("ctaSee")}
              </span>
              <ArrowRight
                className="h-3.5 w-3.5 transition-transform duration-300 group-hover:translate-x-1"
                strokeWidth={1.75}
                style={{ color: CYAN }}
              />
            </a>
          </motion.div>

          <motion.dl
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.9, ease: EASE, delay: 0.5 }}
            className="mt-14 grid max-w-[520px] grid-cols-3 gap-px border"
            style={{ borderColor: LINE, background: LINE }}
          >
            {([1, 2, 3] as const).map((n) => (
              <div
                key={n}
                className="px-4 py-4"
                style={{ background: BG }}
              >
                <dd
                  className="text-[20px] sm:text-[24px]"
                  style={{ fontFamily: MONO, color: FG }}
                >
                  {t(`stat${n}Value`)}
                </dd>
                <dt
                  className="mt-1 text-[9px] uppercase tracking-[0.18em] sm:text-[10px]"
                  style={{ color: FAINT, fontFamily: MONO }}
                >
                  {t(`stat${n}Label`)}
                </dt>
              </div>
            ))}
          </motion.dl>
        </div>

        <div className="relative lg:col-span-5 lg:-ml-6">
          <LiveInvoice />
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Live invoice — the page's signature moment.
// Phases: 0 idle · 1 webhook · 2 header/NIF · 3 lines · 4 totals · 5 stamped
// ─────────────────────────────────────────────────────────────
const PHASE_AT = [0, 500, 1300, 2300, 3300, 4300] as const;
const LOOP_MS = 7600;

function LiveInvoice() {
  const t = useTranslations("shopifyLanding.showcase");
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState(0);
  const [destIdx, setDestIdx] = useState(0);

  useEffect(() => {
    if (reduced) {
      setPhase(5);
      return;
    }
    let timers: ReturnType<typeof setTimeout>[] = [];
    const run = () => {
      setPhase(0);
      timers = PHASE_AT.map((at, i) =>
        setTimeout(() => setPhase(i), at)
      );
      timers.push(
        setTimeout(() => {
          setDestIdx((d) => (d + 1) % DESTINATIONS.length);
          run();
        }, LOOP_MS)
      );
    };
    run();
    return () => timers.forEach(clearTimeout);
  }, [reduced]);

  const dest = DESTINATIONS[destIdx];

  return (
    <motion.div
      initial={{ opacity: 0, y: 30, rotate: 0 }}
      animate={{ opacity: 1, y: 0, rotate: 1.6 }}
      transition={{ duration: 0.9, ease: EASE, delay: 0.35 }}
      className="relative mx-auto w-full max-w-[420px]"
    >
      {/* webhook chip */}
      <AnimatePresence>
        {phase >= 1 && (
          <motion.div
            key={`hook-${destIdx}`}
            initial={{ opacity: 0, x: -36, y: -8 }}
            animate={{ opacity: 1, x: 0, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.15 } }}
            transition={{ duration: 0.45, ease: EASE }}
            className="absolute -top-5 left-4 z-20 flex items-center gap-2 px-3 py-1.5"
            style={{
              background: PANEL,
              border: `1px solid ${LINE}`,
              color: MINT,
              fontFamily: MONO,
              boxShadow: "0 12px 30px -12px rgba(0,0,0,0.8)",
            }}
          >
            <Image
              src="/images/shopify-logo.webp"
              alt="Shopify"
              width={16}
              height={16}
              className="h-4 w-auto rounded-[2px] bg-white p-[1px]"
            />
            <span className="text-[10px] tracking-[0.08em]">
              {t("originSub")}
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* the document */}
      <div
        className="relative overflow-hidden px-6 pb-6 pt-7 sm:px-7"
        style={{
          background: PAPER,
          color: INK,
          fontFamily: MONO,
          boxShadow:
            "0 1px 0 rgba(255,255,255,0.08), 0 40px 80px -30px rgba(0,0,0,0.85), 0 0 0 1px rgba(0,0,0,0.25)",
        }}
      >
        {/* doc header */}
        <div
          className="flex items-start justify-between gap-4 border-b pb-4"
          style={{ borderColor: PAPER_EDGE }}
        >
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em]" style={{ color: INK_FAINT }}>
              Fatura · original
            </div>
            <div className="mt-1 text-[16px] font-semibold tracking-tight">
              FT 2026A/847
            </div>
          </div>
          <AnimatePresence mode="wait">
            <motion.div
              key={dest.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.12 } }}
              transition={{ duration: 0.4, ease: EASE }}
              className="flex h-9 items-center px-2"
            >
              <Image
                src={dest.logo}
                alt={dest.name}
                width={86}
                height={22}
                className="h-[18px] w-auto object-contain"
              />
            </motion.div>
          </AnimatePresence>
        </div>

        {/* client + NIF */}
        <div className="mt-4 space-y-1.5 text-[12px]" style={{ color: INK_DIM }}>
          <TypedLine active={phase >= 2} delay={0}>
            Cliente&nbsp;&nbsp;Ana Martins
          </TypedLine>
          <TypedLine active={phase >= 2} delay={0.25}>
            NIF&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;245 187 663{" "}
            <span style={{ color: "#0E9F6E" }}>✓ válido</span>
          </TypedLine>
        </div>

        {/* lines */}
        <div className="mt-5 border-t pt-3" style={{ borderColor: PAPER_EDGE }}>
          <DocRow
            active={phase >= 3}
            delay={0}
            label="Brincos aço cirúrgico × 2"
            value="24,00"
          />
          <DocRow
            active={phase >= 3}
            delay={0.18}
            label="Portes · CTT Expresso"
            value="4,90"
          />
          <div
            className="my-3 border-t border-dashed"
            style={{ borderColor: PAPER_EDGE }}
          />
          <DocRow
            active={phase >= 4}
            delay={0}
            dim
            label="Subtotal s/ IVA"
            value="23,50"
          />
          <DocRow
            active={phase >= 4}
            delay={0.12}
            dim
            label="IVA 23% · incluído"
            value="5,40"
          />
          <div className="mt-3 flex items-baseline justify-between">
            <span className="text-[11px] uppercase tracking-[0.18em]" style={{ color: INK_FAINT }}>
              Total
            </span>
            <span className="text-[22px] font-semibold tabular-nums tracking-tight">
              <CountUp active={phase >= 4} to={28.9} /> €
            </span>
          </div>
        </div>

        {/* ATCUD + QR + stamp */}
        <div
          className="mt-5 flex items-end justify-between border-t pt-4"
          style={{ borderColor: PAPER_EDGE }}
        >
          <div className="text-[10px] leading-[1.7]" style={{ color: INK_FAINT }}>
            <FadeIn active={phase >= 5}>ATCUD: JFX8PR2J-847</FadeIn>
            <div>Processado por programa certificado · AT</div>
          </div>
          <FadeIn active={phase >= 5}>
            <QrGlyph />
          </FadeIn>
        </div>

        {/* stamp slam */}
        <AnimatePresence>
          {phase >= 5 && (
            <motion.div
              key={`stamp-${destIdx}`}
              initial={{ opacity: 0, scale: 2.1, rotate: -22 }}
              animate={{ opacity: 1, scale: 1, rotate: -9 }}
              exit={{ opacity: 0, transition: { duration: 0.18 } }}
              transition={{ type: "spring", stiffness: 380, damping: 19 }}
              className="pointer-events-none absolute right-5 top-[38%] px-3 py-1.5 text-center"
              style={{
                border: `2.5px solid ${CYAN_DEEP}`,
                color: CYAN_DEEP,
                background: "rgba(244,241,234,0.75)",
                fontFamily: MONO,
              }}
            >
              <div className="text-[13px] font-semibold uppercase tracking-[0.2em]">
                {t("emitted")}
              </div>
              <div className="text-[9px] uppercase tracking-[0.18em] opacity-80">
                &lt; 1s · webhook
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* under-document status line */}
      <div
        className="mt-4 flex items-center justify-between text-[10px] uppercase tracking-[0.18em]"
        style={{ color: FAINT, fontFamily: MONO }}
      >
        <span className="inline-flex items-center gap-2">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: MINT }}
          />
          {t("live")}
        </span>
        <span>{t("engineSub")}</span>
      </div>
    </motion.div>
  );
}

function TypedLine({
  children,
  active,
  delay,
}: {
  children: React.ReactNode;
  active: boolean;
  delay: number;
}) {
  return (
    <div className="relative overflow-hidden whitespace-nowrap">
      <motion.div
        initial={false}
        animate={
          active
            ? { clipPath: "inset(0 0% 0 0)", opacity: 1 }
            : { clipPath: "inset(0 100% 0 0)", opacity: 0 }
        }
        transition={{ duration: 0.45, ease: "easeOut", delay: active ? delay : 0 }}
      >
        {children}
      </motion.div>
    </div>
  );
}

function DocRow({
  label,
  value,
  active,
  delay,
  dim,
}: {
  label: string;
  value: string;
  active: boolean;
  delay: number;
  dim?: boolean;
}) {
  return (
    <motion.div
      initial={false}
      animate={active ? { opacity: 1, y: 0 } : { opacity: 0, y: 6 }}
      transition={{ duration: 0.4, ease: EASE, delay: active ? delay : 0 }}
      className="flex items-baseline justify-between py-1 text-[12px]"
      style={{ color: dim ? INK_FAINT : INK }}
    >
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </motion.div>
  );
}

function FadeIn({
  children,
  active,
}: {
  children: React.ReactNode;
  active: boolean;
}) {
  return (
    <motion.div
      initial={false}
      animate={active ? { opacity: 1 } : { opacity: 0 }}
      transition={{ duration: 0.5, ease: "easeOut" }}
    >
      {children}
    </motion.div>
  );
}

function CountUp({ to, active }: { to: number; active: boolean }) {
  const [val, setVal] = useState(0);
  const ran = useRef(false);

  useEffect(() => {
    if (!active) {
      ran.current = false;
      setVal(0);
      return;
    }
    if (ran.current) return;
    ran.current = true;
    const controls = animate(0, to, {
      duration: 0.8,
      ease: "easeOut",
      onUpdate: (v) => setVal(v),
    });
    return () => controls.stop();
  }, [active, to]);

  return (
    <span>
      {val.toLocaleString("pt-PT", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}
    </span>
  );
}

function QrGlyph() {
  // decorative QR-ish glyph, deterministic pattern
  const cells = [
    1,1,1,0,1,0,1,1,1,
    1,0,1,0,0,1,1,0,1,
    1,1,1,1,0,0,1,1,1,
    0,0,0,1,1,0,1,0,0,
    1,0,1,0,1,1,0,0,1,
    0,1,0,0,1,0,1,1,0,
    1,1,1,0,0,1,0,1,1,
    1,0,1,1,0,0,1,0,0,
    1,1,1,0,1,1,0,1,1,
  ];
  return (
    <div
      aria-hidden
      className="grid h-12 w-12 grid-cols-9 gap-px p-1"
      style={{ background: "rgba(24,28,34,0.06)" }}
    >
      {cells.map((c, i) => (
        <span
          key={i}
          style={{ background: c ? INK : "transparent", opacity: 0.85 }}
        />
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Fiscal artifact ticker
// ─────────────────────────────────────────────────────────────
const TICKER_ITEMS = [
  "FT 2026A/847",
  "ATCUD JFX8PR2J-847",
  "NIF 245 187 663 ✓",
  "IVA 23% · 13% · 6%",
  "M16 · ISENTO",
  "OSS · UE",
  "orders/paid",
  "refunds/create → NC 2026A/12",
  "200 OK · 347 MS",
  "1 ENCOMENDA = 1 FATURA",
];

function Ticker() {
  const row = (
    <div className="flex shrink-0 items-center">
      {TICKER_ITEMS.map((item, i) => (
        <span key={i} className="flex items-center">
          <span
            className="px-6 text-[11px] uppercase tracking-[0.2em]"
            style={{ fontFamily: MONO, color: FAINT }}
          >
            {item}
          </span>
          <span aria-hidden style={{ color: "rgba(47,185,240,0.45)" }}>
            ·
          </span>
        </span>
      ))}
    </div>
  );

  return (
    <div
      aria-hidden
      className="relative z-10 mt-20 overflow-hidden border-y py-3 md:mt-28"
      style={{ borderColor: LINE_SOFT, background: "rgba(13,17,23,0.6)" }}
    >
      <div
        className="rl-marquee-track flex w-max"
        style={{ animation: "rl-marquee 32s linear infinite" }}
      >
        {row}
        {row}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Destinations — one store, three certified programs
// ─────────────────────────────────────────────────────────────
function Destinations() {
  const t = useTranslations("shopifyLanding.dest");
  const reduced = useReducedMotion();
  const [active, setActive] = useState(0);
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    if (pinned || reduced) return;
    const id = setInterval(
      () => setActive((a) => (a + 1) % DESTINATIONS.length),
      2800
    );
    return () => clearInterval(id);
  }, [pinned, reduced]);

  const notes = ["ix", "moloni", "vendus"] as const;

  return (
    <section id="destinos" className="relative px-4 pt-28 md:pt-40">
      <div className="mx-auto grid w-full max-w-[1200px] grid-cols-1 gap-14 lg:grid-cols-12">
        <div className="lg:col-span-5">
          <Eyebrow>{t("eyebrow")}</Eyebrow>
          <h2
            className="mt-5"
            style={{
              fontFamily: DISPLAY,
              fontWeight: 600,
              fontSize: "clamp(2.1rem, 4vw, 3.4rem)",
              lineHeight: 1.0,
              letterSpacing: "-0.025em",
            }}
          >
            {t.rich("title", RICH)}
          </h2>
          <p className="mt-6 max-w-[46ch] text-[15px] leading-[1.6]" style={{ color: DIM }}>
            {t("sub")}
          </p>

          <div className="mt-8 space-y-px border" style={{ borderColor: LINE, background: LINE }}>
            {DESTINATIONS.map((d, i) => (
              <button
                key={d.id}
                type="button"
                onClick={() => {
                  setActive(i);
                  setPinned(true);
                }}
                className="flex w-full items-center justify-between gap-4 px-4 py-3.5 text-left transition-colors duration-300"
                style={{
                  background: active === i ? PANEL : BG,
                }}
                aria-pressed={active === i}
              >
                <span className="flex items-center gap-3">
                  <span
                    className="text-[10px] tabular-nums"
                    style={{ fontFamily: MONO, color: active === i ? CYAN : FAINT }}
                  >
                    0{i + 1}
                  </span>
                  <span
                    className="text-[14px] font-medium"
                    style={{ color: active === i ? FG : DIM }}
                  >
                    {d.name}
                  </span>
                </span>
                <span
                  className="max-w-[24ch] truncate text-right text-[11px]"
                  style={{ fontFamily: MONO, color: FAINT }}
                >
                  {t(notes[i])}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="lg:col-span-7 lg:pl-6">
          <RouterDiagram active={active} />
        </div>
      </div>
    </section>
  );
}

function RouterDiagram({ active }: { active: number }) {
  const t = useTranslations("shopifyLanding.showcase");
  const xs = [80, 280, 480];

  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.7, ease: EASE }}
      className="relative border p-6 sm:p-8"
      style={{ borderColor: LINE, background: PANEL }}
    >
      {/* origin chip */}
      <div className="flex justify-center">
        <div
          className="flex items-center gap-2.5 px-4 py-2.5"
          style={{ background: PAPER, color: INK }}
        >
          <Image
            src="/images/shopify-logo.webp"
            alt="Shopify"
            width={84}
            height={24}
            className="h-5 w-auto object-contain"
          />
          <span
            className="border-l pl-2.5 text-[10px] uppercase tracking-[0.16em]"
            style={{ borderColor: PAPER_EDGE, color: INK_FAINT, fontFamily: MONO }}
          >
            {t("originSub")}
          </span>
        </div>
      </div>

      {/* branch paths */}
      <svg
        viewBox="0 0 560 120"
        className="mx-auto mt-2 block w-full max-w-[560px]"
        aria-hidden
      >
        {xs.map((x, i) => (
          <path
            key={i}
            d={`M 280 8 C 280 60, ${x} 50, ${x} 112`}
            fill="none"
            stroke={active === i ? CYAN : "rgba(237,239,242,0.14)"}
            strokeWidth={active === i ? 1.75 : 1.25}
            strokeDasharray={active === i ? "5 9" : "none"}
            style={
              active === i
                ? { animation: "rl-dash 0.7s linear infinite" }
                : undefined
            }
          />
        ))}
        <circle cx="280" cy="8" r="3" fill={CYAN_DEEP} />
      </svg>

      {/* destination chips */}
      <div className="grid grid-cols-3 gap-3">
        {DESTINATIONS.map((d, i) => (
          <motion.div
            key={d.id}
            animate={{
              y: active === i ? -4 : 0,
              opacity: active === i ? 1 : 0.55,
            }}
            transition={{ duration: 0.4, ease: EASE }}
            className="flex h-16 items-center justify-center px-3"
            style={{
              background: PAPER,
              boxShadow:
                active === i
                  ? `0 0 0 1.5px ${CYAN_DEEP}, 0 18px 36px -18px rgba(2,141,196,0.5)`
                  : "0 10px 24px -16px rgba(0,0,0,0.6)",
            }}
          >
            <Image
              src={d.logo}
              alt={d.name}
              width={110}
              height={26}
              className="h-[20px] w-auto object-contain sm:h-[24px]"
            />
          </motion.div>
        ))}
      </div>

      <div
        className="mt-6 flex items-center justify-between border-t pt-4 text-[10px] uppercase tracking-[0.18em]"
        style={{ borderColor: LINE_SOFT, color: FAINT, fontFamily: MONO }}
      >
        <span>{t("engineTitle")}</span>
        <span style={{ color: MINT }}>{t("tagline")}</span>
      </div>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────
// Audit log — how it works as an event timeline
// ─────────────────────────────────────────────────────────────
function AuditLog() {
  const t = useTranslations("shopifyLanding.how");

  return (
    <section id="como-funciona" className="relative px-4 pt-28 md:pt-40">
      <div className="mx-auto w-full max-w-[1200px]">
        <div className="max-w-[640px]">
          <Eyebrow>{t("eyebrow")}</Eyebrow>
          <h2
            className="mt-5"
            style={{
              fontFamily: DISPLAY,
              fontWeight: 600,
              fontSize: "clamp(2.1rem, 4vw, 3.4rem)",
              lineHeight: 1.0,
              letterSpacing: "-0.025em",
            }}
          >
            {t.rich("title", RICH)}
          </h2>
          <p className="mt-6 text-[15px] leading-[1.6]" style={{ color: DIM }}>
            {t("sub")}
          </p>
        </div>

        <div className="relative mt-16">
          {/* timeline spine */}
          <div
            aria-hidden
            className="absolute bottom-8 left-[7px] top-2 hidden w-px md:block"
            style={{
              backgroundImage: `repeating-linear-gradient(180deg, ${LINE} 0 3px, transparent 3px 9px)`,
            }}
          />

          <StepBlock index={1} stamp="T+0.000s">
            <StepCopy
              label={`${t("stepLabel")} 01`}
              title={t("step1.title")}
              body={t("step1.body")}
            />
            <TerminalCard title="activate.sh">
              {/* code lines are code — kept out of i18n (braces break ICU parsing) */}
              <CodeLine color={CYAN}>POST  /api/integrations/activate</CodeLine>
              <CodeLine>{'{ "shopify_domain": "minha-loja.myshopify.com",'}</CodeLine>
              <CodeLine>{'  "destino": "invoicexpress | moloni | vendus" }'}</CodeLine>
              <CodeLine color={MINT}>{t("step1.code4")}</CodeLine>
            </TerminalCard>
          </StepBlock>

          <StepBlock index={2} stamp="T+2 min">
            <StepCopy
              label={`${t("stepLabel")} 02`}
              title={t("step2.title")}
              body={t("step2.body")}
            />
            <TerminalCard title="fiscal.rules">
              <div className="flex flex-wrap gap-2 py-1">
                {([1, 2, 3, 4] as const).map((n) => (
                  <span
                    key={n}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px]"
                    style={{
                      border: `1px solid ${LINE}`,
                      color: FG,
                      fontFamily: MONO,
                    }}
                  >
                    <Check className="h-3 w-3" style={{ color: MINT }} strokeWidth={2.2} />
                    {t(`step2.pill${n}`)}
                  </span>
                ))}
              </div>
            </TerminalCard>
          </StepBlock>

          <StepBlock index={3} stamp="T+∞" last>
            <StepCopy
              label={`${t("stepLabel")} 03`}
              title={t("step3.title")}
              body={t("step3.body")}
            />
            <TerminalCard title="events.log">
              {([1, 2, 3] as const).map((n) => (
                <div key={n} className="flex items-start gap-2.5 py-0.5">
                  <Check
                    className="mt-0.5 h-3.5 w-3.5 shrink-0"
                    style={{ color: MINT }}
                    strokeWidth={2.2}
                  />
                  <span className="text-[12px] leading-[1.6]" style={{ color: DIM }}>
                    {t(`step3.tick${n}`)}
                  </span>
                </div>
              ))}
            </TerminalCard>
          </StepBlock>
        </div>
      </div>
    </section>
  );
}

function StepBlock({
  index,
  stamp,
  last,
  children,
}: {
  index: number;
  stamp: string;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 26 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.65, ease: EASE, delay: index * 0.04 }}
      className={`relative grid grid-cols-1 gap-8 md:grid-cols-12 md:gap-10 md:pl-12 ${
        last ? "" : "pb-16 md:pb-20"
      }`}
    >
      {/* node */}
      <div
        aria-hidden
        className="absolute left-0 top-1.5 hidden h-[15px] w-[15px] items-center justify-center md:flex"
      >
        <span
          className="h-[15px] w-[15px] rounded-full border-2"
          style={{ borderColor: CYAN_DEEP, background: BG }}
        />
      </div>
      <div
        className="absolute -top-1 left-8 hidden text-[10px] uppercase tracking-[0.18em] md:block"
        style={{ color: FAINT, fontFamily: MONO }}
      >
        {stamp}
      </div>
      {children}
    </motion.div>
  );
}

function StepCopy({
  label,
  title,
  body,
}: {
  label: string;
  title: string;
  body: string;
}) {
  return (
    <div className="md:col-span-5 md:pt-6">
      <div
        className="text-[10px] uppercase tracking-[0.22em]"
        style={{ color: CYAN, fontFamily: MONO }}
      >
        {label}
      </div>
      <h3
        className="mt-3"
        style={{
          fontFamily: DISPLAY,
          fontWeight: 600,
          fontSize: "clamp(1.5rem, 2.4vw, 2.1rem)",
          lineHeight: 1.05,
          letterSpacing: "-0.02em",
        }}
      >
        {title}
      </h3>
      <p className="mt-4 max-w-[44ch] text-[14px] leading-[1.65]" style={{ color: DIM }}>
        {body}
      </p>
    </div>
  );
}

function TerminalCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="md:col-span-7">
      <div
        className="overflow-hidden border"
        style={{ borderColor: LINE, background: PANEL }}
      >
        <div
          className="flex items-center justify-between border-b px-4 py-2.5"
          style={{ borderColor: LINE_SOFT }}
        >
          <div className="flex items-center gap-1.5" aria-hidden>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="h-2 w-2 rounded-full"
                style={{ background: LINE }}
              />
            ))}
          </div>
          <span
            className="text-[10px] uppercase tracking-[0.18em]"
            style={{ color: FAINT, fontFamily: MONO }}
          >
            {title}
          </span>
        </div>
        <div className="px-4 py-4 sm:px-5" style={{ fontFamily: MONO }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function CodeLine({
  children,
  color,
}: {
  children: React.ReactNode;
  color?: string;
}) {
  return (
    <div
      className="whitespace-pre-wrap py-0.5 text-[12px] leading-[1.7]"
      style={{ color: color ?? "rgba(237,239,242,0.75)" }}
    >
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Ledger rows — fiscal trust
// ─────────────────────────────────────────────────────────────
function LedgerRows() {
  const t = useTranslations("shopifyLanding.fiscal");

  return (
    <section id="fiscal" className="relative px-4 pt-28 md:pt-40">
      <div className="mx-auto w-full max-w-[1200px]">
        <div className="max-w-[680px]">
          <Eyebrow>{t("eyebrow")}</Eyebrow>
          <h2
            className="mt-5"
            style={{
              fontFamily: DISPLAY,
              fontWeight: 600,
              fontSize: "clamp(2.1rem, 4vw, 3.4rem)",
              lineHeight: 1.0,
              letterSpacing: "-0.025em",
            }}
          >
            {t.rich("title", RICH)}
          </h2>
          <p className="mt-6 text-[15px] leading-[1.6]" style={{ color: DIM }}>
            {t("sub")}
          </p>
        </div>

        <div className="mt-14 border-t" style={{ borderColor: LINE }}>
          {([1, 2, 3, 4] as const).map((n) => (
            <motion.div
              key={n}
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-60px" }}
              transition={{ duration: 0.55, ease: EASE, delay: n * 0.05 }}
              className="group grid grid-cols-12 items-baseline gap-4 border-b py-7 md:py-9"
              style={{ borderColor: LINE }}
            >
              <div className="col-span-12 md:col-span-2">
                <span
                  aria-hidden
                  className="relative block w-fit text-[2.6rem] leading-none md:text-[3.6rem]"
                  style={{ fontFamily: DISPLAY, fontWeight: 700 }}
                >
                  <span
                    className="transition-opacity duration-500 group-hover:opacity-0"
                    style={{
                      WebkitTextStroke: "1.25px rgba(237,239,242,0.28)",
                      color: "transparent",
                    }}
                  >
                    0{n}
                  </span>
                  <span
                    className="absolute inset-0 opacity-0 transition-opacity duration-500 group-hover:opacity-100"
                    style={{ color: CYAN }}
                  >
                    0{n}
                  </span>
                </span>
              </div>
              <div className="col-span-12 md:col-span-4">
                <h3
                  className="text-[18px] font-medium tracking-tight md:text-[20px]"
                  style={{ fontFamily: DISPLAY, color: FG }}
                >
                  {t(`item${n}Title`)}
                </h3>
              </div>
              <div className="col-span-12 md:col-span-6">
                <p className="max-w-[58ch] text-[14px] leading-[1.65]" style={{ color: DIM }}>
                  {t(`item${n}Body`)}
                </p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Receipt — pricing as a thermal receipt
// ─────────────────────────────────────────────────────────────
const ZIGZAG = {
  height: 10,
  backgroundImage: `linear-gradient(45deg, ${PAPER} 5px, transparent 0),
                    linear-gradient(315deg, ${PAPER} 5px, transparent 0)`,
  backgroundPosition: "left top",
  backgroundRepeat: "repeat-x",
  backgroundSize: "12px 12px",
} as const;

function Receipt() {
  const t = useTranslations("shopifyLanding.pricing");

  const tiers = [
    { key: "monthly", rotate: -1.6, highlight: false, href: "/sign-up", external: false },
    { key: "yearly", rotate: 0, highlight: true, href: "/sign-up", external: false },
    { key: "custom", rotate: 1.4, highlight: false, href: "https://kapta.pt/", external: true },
  ] as const;

  return (
    <section id="preco" className="relative px-4 pt-28 md:pt-40">
      <div className="mx-auto w-full max-w-[1200px]">
        <div className="max-w-[640px]">
          <Eyebrow>{t("eyebrow")}</Eyebrow>
          <h2
            className="mt-5"
            style={{
              fontFamily: DISPLAY,
              fontWeight: 600,
              fontSize: "clamp(2.1rem, 4vw, 3.4rem)",
              lineHeight: 1.0,
              letterSpacing: "-0.025em",
            }}
          >
            {t.rich("title", RICH)}
          </h2>
          <p className="mt-6 max-w-[46ch] text-[15px] leading-[1.6]" style={{ color: DIM }}>
            {t("sub")}
          </p>
        </div>

        <div className="mt-16 grid grid-cols-1 items-start gap-10 md:grid-cols-3 md:gap-6 lg:gap-8">
          {tiers.map((tier, i) => (
            <ReceiptCard key={tier.key} tier={tier} index={i} />
          ))}
        </div>

        <div className="mt-12 flex flex-col items-center gap-4">
          <p
            className="text-center text-[10px] uppercase tracking-[0.18em]"
            style={{ color: FAINT, fontFamily: MONO }}
          >
            {t("notice")}
          </p>
          <Link href="/#preco" className="text-[13px]" style={{ color: DIM }}>
            <span className="border-b pb-0.5" style={{ borderColor: LINE }}>
              {t("fullLink")} ↗
            </span>
          </Link>
        </div>
      </div>
    </section>
  );
}

function ReceiptCard({
  tier,
  index,
}: {
  tier: {
    key: "monthly" | "yearly" | "custom";
    rotate: number;
    highlight: boolean;
    href: string;
    external: boolean;
  };
  index: number;
}) {
  const t = useTranslations(`shopifyLanding.pricing.${tier.key}`);
  const isCustom = tier.key === "custom";

  const cta = tier.external ? (
    <a
      href={tier.href}
      target="_blank"
      rel="noopener noreferrer"
      className="group mt-6 flex w-full items-center justify-center gap-2 border py-3 text-[12px] font-semibold uppercase tracking-[0.14em] transition-colors duration-300"
      style={{ borderColor: INK, color: INK, fontFamily: MONO }}
    >
      {t("cta")}
      <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.75} />
    </a>
  ) : (
    <Link
      href={tier.href}
      className="group mt-6 flex w-full items-center justify-center gap-2 py-3 text-[12px] font-semibold uppercase tracking-[0.14em] transition-transform duration-300 active:scale-[0.98]"
      style={{
        background: tier.highlight ? CYAN_DEEP : INK,
        color: "#FFFFFF",
        fontFamily: MONO,
        boxShadow: tier.highlight
          ? "inset 0 1px 0 rgba(255,255,255,0.2), 0 14px 30px -12px rgba(2,141,196,0.55)"
          : "inset 0 1px 0 rgba(255,255,255,0.12)",
      }}
    >
      {t("cta")}
      <ArrowRight
        className="h-3.5 w-3.5 transition-transform duration-300 group-hover:translate-x-1"
        strokeWidth={1.75}
      />
    </Link>
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 30, rotate: 0 }}
      whileInView={{ opacity: 1, y: tier.highlight ? -8 : 0, rotate: tier.rotate }}
      viewport={{ once: true, margin: "-80px" }}
      whileHover={{ rotate: 0, y: tier.highlight ? -12 : -4 }}
      transition={{ duration: 0.65, ease: EASE, delay: index * 0.08 }}
      className="relative mx-auto w-full max-w-[360px]"
      style={{
        filter: tier.highlight
          ? "drop-shadow(0 40px 60px rgba(2,141,196,0.25))"
          : "drop-shadow(0 32px 50px rgba(0,0,0,0.55))",
        zIndex: tier.highlight ? 10 : 1,
      }}
    >
      {/* recommended stamp */}
      {tier.highlight && (
        <div
          className="absolute -top-3 left-1/2 z-20 -translate-x-1/2 rotate-[-4deg] border-2 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em]"
          style={{
            borderColor: CYAN_DEEP,
            color: CYAN_DEEP,
            background: PAPER,
            fontFamily: MONO,
          }}
        >
          {t("badge")}
        </div>
      )}

      <div aria-hidden style={ZIGZAG} />
      <div
        className="px-6 py-7 sm:px-7"
        style={{
          background: PAPER,
          color: INK,
          fontFamily: MONO,
          boxShadow: tier.highlight ? `inset 0 0 0 2px ${CYAN_DEEP}` : undefined,
        }}
      >
        <div className="text-center">
          <div
            className="text-[10px] uppercase tracking-[0.3em]"
            style={{ color: INK_FAINT }}
          >
            Rioko · Shopify · {t("name")}
          </div>
          <div
            className={`mt-4 leading-none tracking-tight ${
              isCustom ? "text-[26px] sm:text-[30px]" : "text-[40px] sm:text-[44px]"
            }`}
            style={{ fontFamily: DISPLAY, fontWeight: 700 }}
          >
            {t("price")}
          </div>
          <div className="mt-2 text-[11px]" style={{ color: INK_DIM }}>
            {t("period")}
          </div>
          {tier.key === "yearly" && (
            <div
              className="mt-1 text-[10px] font-semibold uppercase tracking-[0.08em]"
              style={{ color: "#0E9F6E" }}
            >
              {t("save")}
            </div>
          )}
        </div>

        <div
          className="my-5 border-t border-dashed"
          style={{ borderColor: "rgba(24,28,34,0.25)" }}
        />

        <div className="space-y-2.5">
          {([1, 2, 3, 4] as const).map((n) => (
            <div
              key={n}
              className="flex items-baseline justify-between gap-3 text-[11.5px]"
            >
              <span style={{ color: INK_DIM }}>{t(`b${n}`)}</span>
              <span
                className="shrink-0 text-[9px] uppercase tracking-[0.14em]"
                style={{ color: "#0E9F6E" }}
              >
                ✓
              </span>
            </div>
          ))}
        </div>

        {cta}

        <div
          className="mt-6 border-t border-dashed pt-5"
          style={{ borderColor: "rgba(24,28,34,0.25)" }}
        />

        {/* barcode */}
        <div
          aria-hidden
          className="mx-auto h-8 w-[170px]"
          style={{
            backgroundImage: `repeating-linear-gradient(90deg,
              ${INK} 0 2px, transparent 2px 5px,
              ${INK} 5px 6px, transparent 6px 11px,
              ${INK} 11px 14px, transparent 14px 16px,
              ${INK} 16px 17px, transparent 17px 21px)`,
          }}
        />
        <div
          className="mt-2 text-center text-[9px] tracking-[0.4em]"
          style={{ color: INK_FAINT }}
        >
          RIOKO·SHOPIFY·{t("name").toUpperCase()}
        </div>
      </div>
      <div aria-hidden style={{ ...ZIGZAG, transform: "scaleY(-1)" }} />
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────
// FAQ — document index accordion
// ─────────────────────────────────────────────────────────────
function Faq() {
  const t = useTranslations("shopifyLanding.faq");
  const items = t.raw("items") as Array<{ q: string; a: string }>;
  const [open, setOpen] = useState<number | null>(0);

  return (
    <section id="faq" className="relative px-4 pt-28 md:pt-40">
      <div className="mx-auto grid w-full max-w-[1200px] grid-cols-1 gap-12 lg:grid-cols-12">
        <div className="lg:col-span-4">
          <Eyebrow>{t("eyebrow")}</Eyebrow>
          <h2
            className="mt-5"
            style={{
              fontFamily: DISPLAY,
              fontWeight: 600,
              fontSize: "clamp(2.1rem, 4vw, 3rem)",
              lineHeight: 1.0,
              letterSpacing: "-0.025em",
            }}
          >
            {t.rich("title", RICH)}
          </h2>
          <p className="mt-6 max-w-[38ch] text-[14px] leading-[1.6]" style={{ color: DIM }}>
            {t("sub")}
          </p>
        </div>

        <div className="lg:col-span-8">
          <div className="border-t" style={{ borderColor: LINE }}>
            {items.map((item, i) => {
              const isOpen = open === i;
              return (
                <div
                  key={i}
                  className="border-b"
                  style={{ borderColor: LINE }}
                >
                  <button
                    type="button"
                    onClick={() => setOpen(isOpen ? null : i)}
                    aria-expanded={isOpen}
                    className="flex w-full items-baseline gap-5 py-5 text-left transition-opacity hover:opacity-90"
                  >
                    <span
                      className="shrink-0 text-[10px] tabular-nums"
                      style={{
                        fontFamily: MONO,
                        color: isOpen ? CYAN : FAINT,
                      }}
                    >
                      Q.{String(i + 1).padStart(2, "0")}
                    </span>
                    <span
                      data-faq-question
                      className="flex-1 text-[15px] font-medium tracking-tight sm:text-[17px]"
                      style={{ color: FG, fontFamily: DISPLAY }}
                    >
                      {item.q}
                    </span>
                    <Plus
                      className="h-4 w-4 shrink-0 self-center transition-transform duration-300"
                      style={{
                        color: CYAN,
                        transform: isOpen ? "rotate(45deg)" : "none",
                      }}
                      strokeWidth={1.75}
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
                          className="max-w-[64ch] pb-6 pl-[3.4rem] text-[13.5px] leading-[1.65]"
                          style={{ color: DIM }}
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
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Stamp CTA
// ─────────────────────────────────────────────────────────────
function StampCTA() {
  const t = useTranslations("shopifyLanding.cta");

  return (
    <section className="relative px-4 pb-10 pt-28 md:pt-44">
      <div
        className="mx-auto w-full max-w-[1200px] border px-6 py-16 text-center sm:py-20 md:py-24"
        style={{
          borderColor: LINE,
          background: `radial-gradient(60% 80% at 50% 0%, rgba(2,141,196,0.12), transparent 70%), ${PANEL}`,
        }}
      >
        <div
          className="text-[10px] uppercase tracking-[0.26em]"
          style={{ color: FAINT, fontFamily: MONO }}
        >
          {t("eyebrow")}
        </div>
        <h2
          className="mx-auto mt-6 max-w-[18ch]"
          style={{
            fontFamily: DISPLAY,
            fontWeight: 600,
            fontSize: "clamp(2.4rem, 5.5vw, 4.6rem)",
            lineHeight: 0.98,
            letterSpacing: "-0.03em",
            textWrap: "balance" as const,
          }}
        >
          {t.rich("title", RICH)}
        </h2>
        <p
          className="mx-auto mt-6 max-w-[42ch] text-[15px] leading-[1.6]"
          style={{ color: DIM }}
        >
          {t("body")}
        </p>

        <div className="mt-12 flex flex-col items-center gap-6">
          <motion.div
            initial={{ rotate: -2.5 }}
            whileHover={{ rotate: 0, scale: 1.02 }}
            whileTap={{ scale: 0.97 }}
            transition={{ type: "spring", stiffness: 320, damping: 16 }}
          >
            <Link
              href="/sign-up"
              className="inline-block border-[3px] px-10 py-5 text-[18px] font-semibold uppercase tracking-[0.12em] transition-colors duration-300 sm:text-[20px]"
              style={{
                fontFamily: DISPLAY,
                borderColor: CYAN,
                color: CYAN,
                background: "rgba(47,185,240,0.05)",
              }}
            >
              {t("start")}
            </Link>
          </motion.div>
          <Link href="/sign-in" className="text-[13px]" style={{ color: FAINT }}>
            <span className="border-b pb-0.5" style={{ borderColor: LINE }}>
              {t("signIn")}
            </span>
          </Link>
        </div>

        <div
          className="mx-auto mt-14 flex max-w-[420px] items-center justify-center gap-2 text-[10px] uppercase tracking-[0.18em]"
          style={{ color: FAINT, fontFamily: MONO }}
        >
          <ShieldCheck className="h-3.5 w-3.5" strokeWidth={1.5} style={{ color: MINT }} />
          ATCUD · NIF · IVA · M01–M99 · OSS
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Footer
// ─────────────────────────────────────────────────────────────
function FooterSlim() {
  const t = useTranslations("landing.footer");
  const tNav = useTranslations("shopifyLanding.nav");

  return (
    <footer className="relative px-4 pb-10 pt-10">
      <div
        className="mx-auto flex w-full max-w-[1200px] flex-col items-center justify-between gap-5 border-t pt-8 md:flex-row"
        style={{ borderColor: LINE_SOFT }}
      >
        <div className="flex items-center gap-3">
          <Link href="/" aria-label="Rioko">
            <Image
              src="/images/rioko2-logo.svg"
              alt="Rioko"
              width={96}
              height={20}
            />
          </Link>
          <span
            className="text-[10px] uppercase tracking-[0.18em]"
            style={{ color: FAINT, fontFamily: MONO }}
          >
            {t("rights", { year: new Date().getFullYear() })}
          </span>
        </div>
        <nav
          className="flex items-center gap-6 text-[11px] uppercase tracking-[0.16em]"
          style={{ fontFamily: MONO }}
        >
          <Link href="/" style={{ color: FAINT }}>
            {tNav("hub")}
          </Link>
          <Link href="/privacy" style={{ color: FAINT }}>
            {t("privacy")}
          </Link>
          <Link href="/terms" style={{ color: FAINT }}>
            {t("terms")}
          </Link>
        </nav>
      </div>
    </footer>
  );
}

// ─────────────────────────────────────────────────────────────
// Shared bits
// ─────────────────────────────────────────────────────────────
function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-2.5 text-[10px] uppercase tracking-[0.26em]"
      style={{ color: CYAN, fontFamily: MONO }}
    >
      <span aria-hidden className="h-px w-8" style={{ background: CYAN_DEEP }} />
      {children}
    </span>
  );
}
