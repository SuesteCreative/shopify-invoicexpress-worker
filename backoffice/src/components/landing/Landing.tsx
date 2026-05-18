"use client";

import * as React from "react";
import { motion } from "framer-motion";
import Link from "next/link";
import Image from "next/image";
import { useEffect, useState, memo } from "react";
import { AnimatePresence } from "framer-motion";
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
} from "lucide-react";

// ─────────────────────────────────────────────────────────────
// Design tokens — Stripe Apps / Raycast tech-dark
// ─────────────────────────────────────────────────────────────
const SURFACE = "#0E1116"; // charcoal base
const SURFACE_2 = "#14181F"; // tile bg one step up
const FG = "#F0F0F0";
const FG_60 = "rgba(240,240,240,0.62)";
const FG_40 = "rgba(240,240,240,0.40)";
const RULE = "rgba(255,255,255,0.08)";
const HAIRLINE = "rgba(255,255,255,0.06)";
const ACCENT = "#028DC4"; // Rioko brand cyan (matches logo pill)
const ACCENT_HOT = "#5EEAD4"; // mint — live indicators, ticks
const SOON = "#F59E0B"; // amber — "em breve" badges

const EASE: [number, number, number, number] = [0.32, 0.72, 0, 1];

// Glass surface recipe — applied uniformly to all cards
const GLASS = {
  background: "rgba(255,255,255,0.03)",
  border: `1px solid ${HAIRLINE}`,
  backdropFilter: "blur(20px)",
  WebkitBackdropFilter: "blur(20px)",
  boxShadow:
    "inset 0 1px 0 rgba(255,255,255,0.06), 0 24px 48px -28px rgba(0,0,0,0.6)",
} as const;

// ─────────────────────────────────────────────────────────────
// Integration registry
// ─────────────────────────────────────────────────────────────
type Status = "live" | "soon" | "planned";

type Integration = {
  id: string;
  name: string;
  kind: "pagamentos" | "faturação";
  status: Status;
  logoSrc?: string;
  logoW?: number;
  logoH?: number;
  mark?: string;
  brand?: string;
  note: string;
};

const INTEGRATIONS: Integration[] = [
  {
    id: "shopify",
    name: "Shopify",
    kind: "pagamentos",
    status: "live",
    logoSrc: "/images/shopify-logo.webp",
    logoW: 28,
    logoH: 28,
    note: "Encomendas pagas → fatura em < 1s",
  },
  {
    id: "stripe",
    name: "Stripe",
    kind: "pagamentos",
    status: "live",
    mark: "S",
    brand: "#635BFF",
    note: "Assinaturas, charges e refunds via webhook",
  },
  {
    id: "eupago",
    name: "EuPago",
    kind: "pagamentos",
    status: "soon",
    mark: "Eu",
    brand: "#E63946",
    note: "Multibanco, MB WAY e referências",
  },
  {
    id: "easypay",
    name: "Easypay",
    kind: "pagamentos",
    status: "soon",
    mark: "Ep",
    brand: "#D7263D",
    note: "Captura imediata e diferida",
  },
  {
    id: "ifthenpay",
    name: "Ifthenpay",
    kind: "pagamentos",
    status: "planned",
    mark: "If",
    brand: "#1F6FEB",
    note: "MB WAY, Multibanco, Payshop",
  },
  {
    id: "invoicexpress",
    name: "InvoiceXpress",
    kind: "faturação",
    status: "live",
    logoSrc: "/images/invoicexpress_logo2.png",
    logoW: 30,
    logoH: 30,
    note: "Faturas, recibos, notas de crédito",
  },
  {
    id: "moloni",
    name: "Moloni",
    kind: "faturação",
    status: "planned",
    mark: "Mo",
    brand: "#E11D48",
    note: "Sincronização total de documentos",
  },
  {
    id: "vendus",
    name: "Vendus",
    kind: "faturação",
    status: "planned",
    mark: "Vd",
    brand: "#16A34A",
    note: "POS + faturação certificada",
  },
];

const STATUS_LABEL: Record<Status, string> = {
  live: "Ativo",
  soon: "Em breve",
  planned: "Em estudo",
};

// ─────────────────────────────────────────────────────────────
// Tiny mono token — used for inline technical emphasis
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

// Gradient highlight — same family as the Rioko Engine card
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

// ─────────────────────────────────────────────────────────────
// Flow rotation registries — origin + destination carousels
// Placeholder logos use brand monograms until SVG assets land.
// To swap in a real logo: set logoSrc to "/images/<name>-logo.svg"
// ─────────────────────────────────────────────────────────────
type FlowSlot = {
  id: string;
  title: string;
  sub: string;
  logoSrc: string | null;
  mark?: string;
  brand?: string;
};

const ORIGIN_SLOTS: FlowSlot[] = [
  {
    id: "shopify",
    title: "Shopify",
    sub: "encomenda paga · #1042",
    logoSrc: "/images/shopify-logo.webp",
  },
  {
    id: "stripe",
    title: "Stripe",
    sub: "charge succeeded · ch_3R9",
    logoSrc: null,
    mark: "S",
    brand: "#635BFF",
  },
  {
    id: "easypay",
    title: "Easypay",
    sub: "capture · pmt_5921",
    logoSrc: null,
    mark: "Ep",
    brand: "#D7263D",
  },
  {
    id: "eupago",
    title: "EuPago",
    sub: "MB WAY confirmado · #2847",
    logoSrc: null,
    mark: "Eu",
    brand: "#E63946",
  },
  {
    id: "ifthenpay",
    title: "Ifthenpay",
    sub: "MB referência · #883",
    logoSrc: null,
    mark: "If",
    brand: "#1F6FEB",
  },
];

const DESTINATION_SLOTS: FlowSlot[] = [
  {
    id: "invoicexpress",
    title: "InvoiceXpress",
    sub: "FT 2026/A/847 · finalizada",
    logoSrc: "/images/invoicexpress_logo2.png",
  },
  {
    id: "moloni",
    title: "Moloni",
    sub: "FT 2026/A/523 · finalizada",
    logoSrc: null,
    mark: "Mo",
    brand: "#E11D48",
  },
  {
    id: "vendus",
    title: "Vendus",
    sub: "FT 2026/A/319 · finalizada",
    logoSrc: null,
    mark: "Vd",
    brand: "#16A34A",
  },
];

const ROTATION_MS = 3200;

// ─────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────
export default function Landing() {
  // Body chrome — match SURFACE so overscroll doesn't flash slate-950
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
      {/* Cool radial washes — single accent family, low opacity */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0"
        style={{
          backgroundImage: `radial-gradient(60% 40% at 8% 0%, rgba(2,141,196,0.10), transparent 60%),
                            radial-gradient(50% 35% at 100% 100%, rgba(94,234,212,0.06), transparent 60%)`,
        }}
      />

      {/* Subtle hero vignette to ground the showcase */}
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
        <FinalCTA />
        <Footer />
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Nav — floating glass pill on charcoal
// ─────────────────────────────────────────────────────────────
function Nav() {
  return (
    <div className="relative z-50 px-4 pt-6 md:pt-8">
      <motion.nav
        initial={{ y: -16, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.7, ease: EASE }}
        className="mx-auto flex w-full max-w-[1280px] items-center justify-between gap-4 rounded-full px-2 py-2"
        style={{
          ...GLASS,
          background: "rgba(20,24,31,0.62)",
        }}
      >
        <div className="flex items-center gap-3 pl-3">
          <Image
            src="/images/rioko2-logo.svg"
            alt="Rioko 2.0"
            width={132}
            height={27}
            priority
          />
          <span
            className="hidden font-mono text-[10px] uppercase tracking-[0.18em] sm:inline-block"
            style={{ color: FG_40 }}
          >
            Engine
          </span>
        </div>

        <div className="hidden items-center gap-7 md:flex">
          <a
            href="#integracoes"
            className="text-[13px] transition-colors hover:opacity-100"
            style={{ color: FG_60 }}
          >
            Integrações
          </a>
          <a
            href="#como-funciona"
            className="text-[13px] transition-colors"
            style={{ color: FG_60 }}
          >
            Como funciona
          </a>
          <a
            href="#fiscal"
            className="text-[13px] transition-colors"
            style={{ color: FG_60 }}
          >
            Conformidade
          </a>
        </div>

        <div className="flex items-center gap-2">
          <Link
            href="/sign-in"
            className="hidden px-4 py-2 text-[13px] sm:inline-block"
            style={{ color: FG }}
          >
            Entrar
          </Link>
          <Link
            href="/sign-up"
            className="group inline-flex items-center gap-2 rounded-full py-2 pl-4 pr-2 text-[13px] font-medium transition-all duration-500 active:scale-[0.98]"
            style={{
              background: FG,
              color: SURFACE,
              boxShadow:
                "0 1px 0 rgba(0,0,0,0.08) inset, 0 8px 20px -10px rgba(0,0,0,0.6)",
              transitionTimingFunction: "cubic-bezier(0.32,0.72,0,1)",
            }}
          >
            Começar
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
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Hero
// ─────────────────────────────────────────────────────────────
function Hero() {
  return (
    <section className="relative px-4 pt-14 md:pt-24">
      <div className="mx-auto grid w-full max-w-[1280px] grid-cols-1 gap-12 md:grid-cols-12 md:gap-10">
        {/* LEFT — headline */}
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
              Hub de Integrações
            </span>
          </motion.div>

          <motion.h1
            initial={{ y: 18, opacity: 0, filter: "blur(6px)" }}
            animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
            transition={{ duration: 0.9, ease: EASE, delay: 0.1 }}
            className="tracking-[-0.025em]"
            style={{
              fontFamily: "var(--font-sans-display), system-ui, sans-serif",
              fontSize: "clamp(3rem, 7vw, 6.5rem)",
              lineHeight: 0.95,
              color: FG,
              fontWeight: 500,
              textWrap: "balance" as const,
            }}
          >
            Uma <Gradient>fatura</Gradient>.<br />
            Para cada <Gradient>encomenda</Gradient>.<br />
            <span style={{ color: FG_60 }}>
              De cada <Gradient>plataforma</Gradient>.
            </span>
          </motion.h1>

          <motion.p
            initial={{ y: 12, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.7, ease: EASE, delay: 0.25 }}
            className="mt-7 max-w-[52ch] text-[16px] leading-[1.55]"
            style={{ color: FG_60 }}
          >
            Rioko é o motor que conecta a sua loja, o seu gateway de pagamento
            e o seu programa de faturação. Webhook entra,{" "}
            <span style={{ color: ACCENT_HOT }}>fatura sai</span> — em menos
            de um segundo, com NIF detectado, IVA calculado e isenção fiscal
            aplicada conforme o código M01–M99.
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
              Criar conta grátis
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
                Ver integrações disponíveis
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
            className="mt-14 grid max-w-[560px] grid-cols-3 gap-6 border-t pt-6"
            style={{ borderColor: RULE }}
          >
            <Stat value="< 1s" label="webhook → fatura" />
            <Stat value="1 : 1" label="encomenda : fatura" />
            <Stat value="M01–M99" label="isenções suportadas" />
          </motion.div>
        </div>

        {/* RIGHT — showcase */}
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
        className="font-mono text-[22px] tabular-nums"
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
// Hero showcase — glass card w/ live flow
// ─────────────────────────────────────────────────────────────
function HeroShowcase() {
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
            label="Origem"
            slots={ORIGIN_SLOTS}
            initialDelayMs={500}
          />

          <FlowConnector delay={0.7} />

          {/* Rioko Engine — accent moment */}
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
              <div className="flex items-center gap-3">
                <div
                  className="flex h-9 w-9 items-center justify-center rounded-full"
                  style={{ background: "rgba(255,255,255,0.14)" }}
                >
                  <Workflow className="h-4 w-4" strokeWidth={1.5} />
                </div>
                <div>
                  <div className="text-[13px] font-medium">Rioko Engine</div>
                  <div
                    className="font-mono text-[10px] uppercase tracking-[0.18em]"
                    style={{ color: "rgba(255,255,255,0.7)" }}
                  >
                    NIF · IVA · Isenção · Cliente
                  </div>
                </div>
              </div>
              <div
                className="font-mono text-[10px] tabular-nums"
                style={{ color: "rgba(255,255,255,0.8)" }}
              >
                347 ms
              </div>
            </div>

            <div className="mt-4 grid grid-cols-4 gap-2">
              {["NIF", "IVA", "Cliente", "M99"].map((step, i) => (
                <motion.div
                  key={step}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    duration: 0.4,
                    ease: EASE,
                    delay: 1.05 + i * 0.08,
                  }}
                  className="flex items-center gap-1.5 rounded-md px-2 py-1"
                  style={{ background: "rgba(255,255,255,0.12)" }}
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

          <FlowConnector delay={1.3} />

          <RotatingFlowCard
            label="Destino"
            slots={DESTINATION_SLOTS}
            initialDelayMs={1500}
            offsetMs={ROTATION_MS / 2}
            tone="success"
          />

          <div
            className="mt-5 flex items-center justify-between border-t pt-4 text-[11px]"
            style={{ borderColor: HAIRLINE, color: FG_40 }}
          >
            <span className="font-mono uppercase tracking-[0.16em]">
              fluxo real · ao vivo
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Clock className="h-3 w-3" strokeWidth={1.5} />
              ontem · 14h27
            </span>
          </div>
        </div>
      </div>

      <motion.div
        initial={{ opacity: 0, rotate: -6, y: 12 }}
        animate={{ opacity: 1, rotate: -6, y: 0 }}
        transition={{ duration: 0.8, ease: EASE, delay: 1.7 }}
        className="absolute -bottom-5 -left-5 hidden rounded-full px-3 py-1.5 md:inline-flex"
        style={{
          border: `1px solid ${RULE}`,
          background: SURFACE_2,
          color: ACCENT_HOT,
          boxShadow: "0 10px 24px -12px rgba(0,0,0,0.6)",
        }}
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.22em]">
          1 encomenda · 1 fatura · sempre
        </span>
      </motion.div>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────
// Rotating flow card — isolated client component, memoized.
// Owns its own interval so its re-renders don't trigger
// re-renders in the parent hero showcase.
// ─────────────────────────────────────────────────────────────
const RotatingFlowCard = memo(function RotatingFlowCard({
  label,
  slots,
  initialDelayMs = 0,
  offsetMs = 0,
  tone,
}: {
  label: string;
  slots: FlowSlot[];
  initialDelayMs?: number;
  offsetMs?: number;
  tone?: "success";
}) {
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const start = setTimeout(() => {
      intervalId = setInterval(() => {
        setIdx((p) => (p + 1) % slots.length);
      }, ROTATION_MS);
    }, initialDelayMs + offsetMs);

    return () => {
      clearTimeout(start);
      if (intervalId) clearInterval(intervalId);
    };
  }, [slots.length, initialDelayMs, offsetMs]);

  const slot = slots[idx];

  return (
    <div className="relative">
      {/* Static outer frame so heights stay locked while inner content swaps */}
      <div
        className="relative overflow-hidden rounded-2xl"
        style={{
          border: `1px solid ${HAIRLINE}`,
          background: SURFACE_2,
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)",
          minHeight: 72,
        }}
      >
        <AnimatePresence mode="wait">
          <motion.div
            key={slot.id}
            initial={{ opacity: 0, y: 8, filter: "blur(4px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -8, filter: "blur(4px)" }}
            transition={{ duration: 0.45, ease: EASE }}
            className="flex items-center justify-between p-4"
          >
            <FlowSlotIdentity label={label} slot={slot} />
            <div className="text-right">
              <div
                className="font-mono text-[11px] tabular-nums"
                style={{ color: FG_60 }}
              >
                {slot.sub}
              </div>
              {tone === "success" && (
                <div
                  className="mt-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5"
                  style={{
                    background: "rgba(94,234,212,0.10)",
                    color: ACCENT_HOT,
                  }}
                >
                  <Check className="h-2.5 w-2.5" strokeWidth={2.4} />
                  <span className="font-mono text-[9px] uppercase tracking-[0.2em]">
                    emitida
                  </span>
                </div>
              )}
            </div>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Progress dots */}
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
    <div className="flex items-center gap-3">
      <div
        className="flex h-9 w-9 items-center justify-center rounded-xl overflow-hidden"
        style={{
          background: slot.logoSrc
            ? "rgba(255,255,255,0.04)"
            : slot.brand ?? SURFACE,
          border: slot.logoSrc ? `1px solid ${HAIRLINE}` : "none",
          boxShadow: slot.logoSrc
            ? "none"
            : "inset 0 1px 0 rgba(255,255,255,0.18)",
        }}
      >
        {slot.logoSrc ? (
          <Image
            src={slot.logoSrc}
            alt=""
            width={20}
            height={20}
            className="object-contain"
          />
        ) : (
          <span
            className="font-mono text-[12px] font-medium"
            style={{
              color: "#FFFFFF",
              letterSpacing: "-0.02em",
            }}
          >
            {slot.mark}
          </span>
        )}
      </div>
      <div>
        <div
          className="font-mono text-[10px] uppercase tracking-[0.18em]"
          style={{ color: FG_40 }}
        >
          {label}
        </div>
        <div className="text-[14px] font-medium" style={{ color: FG }}>
          {slot.title}
        </div>
      </div>
    </div>
  );
}

function FlowConnector({ delay }: { delay: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, scaleY: 0.4 }}
      animate={{ opacity: 1, scaleY: 1 }}
      transition={{ duration: 0.5, ease: EASE, delay }}
      className="my-2 flex items-center justify-center"
      style={{ transformOrigin: "center top" }}
    >
      <div
        className="h-6 w-px"
        style={{
          backgroundImage: `repeating-linear-gradient(180deg, ${FG_40} 0 2px, transparent 2px 6px)`,
        }}
      />
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────
// Integration Matrix
// ─────────────────────────────────────────────────────────────
function IntegrationMatrix() {
  const pagamentos = INTEGRATIONS.filter((i) => i.kind === "pagamentos");
  const faturação = INTEGRATIONS.filter((i) => i.kind === "faturação");

  return (
    <section id="integracoes" className="relative px-4 pt-32 md:pt-44">
      <div className="mx-auto w-full max-w-[1280px]">
        <SectionHead
          eyebrow="O hub"
          title={
            <>
              Cada plataforma fala com a <Mono color={ACCENT_HOT}>Rioko</Mono>.
              <br />A Rioko fala com <Mono color={ACCENT_HOT}>cada</Mono>{" "}
              programa de faturação.
            </>
          }
          sub="Em vez de manter sete integrações ponto-a-ponto, mantém uma. Adicionamos pagamentos e programas de faturação ao motor à medida que o ecossistema cresce."
        />

        <IntegrationGroup
          kind="Pagamentos"
          subtitle="entrada · pedidos pagos chegam por webhook"
          items={pagamentos}
        />

        <div className="my-14 h-px w-full" style={{ background: RULE }} />

        <IntegrationGroup
          kind="Faturação"
          subtitle="saída · documentos emitidos ao gateway certo"
          items={faturação}
        />

        <div
          className="mt-16 flex flex-wrap items-center justify-between gap-4 rounded-2xl px-5 py-4"
          style={{
            ...GLASS,
          }}
        >
          <div className="flex items-center gap-3">
            <Layers
              className="h-4 w-4"
              style={{ color: FG_60 }}
              strokeWidth={1.5}
            />
            <div>
              <div className="text-[13px]" style={{ color: FG }}>
                Falta uma integração que precisa?
              </div>
              <div
                className="font-mono text-[10px] uppercase tracking-[0.18em]"
                style={{ color: FG_40 }}
              >
                priorizamos por procura real
              </div>
            </div>
          </div>
          <a
            href="mailto:rioko@kapta.pt?subject=Pedido%20de%20integração"
            className="group inline-flex items-center gap-2 text-[13px]"
            style={{ color: FG }}
          >
            <span
              className="border-b"
              style={{ borderColor: "rgba(255,255,255,0.16)" }}
            >
              Pedir nova integração
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
      <div className="mb-6 flex items-baseline justify-between gap-4">
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
      className="group relative rounded-[1.25rem] p-1.5"
      style={{
        background: isLive
          ? "rgba(255,255,255,0.05)"
          : "rgba(255,255,255,0.025)",
      }}
    >
      <div
        className="relative h-full overflow-hidden rounded-[calc(1.25rem-0.375rem)] p-5 transition-all duration-500"
        style={{
          ...GLASS,
          background: "rgba(20,24,31,0.55)",
          transitionTimingFunction: "cubic-bezier(0.32,0.72,0,1)",
        }}
      >
        {/* Hover ring */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[calc(1.25rem-0.375rem)] opacity-0 transition-opacity duration-500 group-hover:opacity-100"
          style={{
            boxShadow: `inset 0 0 0 1px rgba(2,141,196,0.35)`,
            transitionTimingFunction: "cubic-bezier(0.32,0.72,0,1)",
          }}
        />

        <div className="relative flex items-start justify-between">
          <Mark item={item} />
          <StatusBadge status={item.status} />
        </div>

        <div className="relative mt-6">
          <div
            className="text-[18px] font-medium tracking-tight"
            style={{ color: FG }}
          >
            {item.name}
          </div>
          <div
            className="mt-1 text-[13px] leading-[1.45]"
            style={{ color: FG_60 }}
          >
            {item.note}
          </div>
        </div>

        {!isLive && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-[calc(1.25rem-0.375rem)]"
            style={{
              backgroundImage:
                "repeating-linear-gradient(135deg, rgba(255,255,255,0.025) 0 6px, transparent 6px 12px)",
            }}
          />
        )}
      </div>
    </motion.div>
  );
}

function Mark({ item }: { item: Integration }) {
  if (item.logoSrc) {
    return (
      <div
        className="flex h-11 w-11 items-center justify-center rounded-xl"
        style={{
          background: "rgba(255,255,255,0.06)",
          border: `1px solid ${HAIRLINE}`,
        }}
      >
        <Image
          src={item.logoSrc}
          alt={item.name}
          width={item.logoW ?? 22}
          height={item.logoH ?? 22}
          className="object-contain"
        />
      </div>
    );
  }
  return (
    <div
      className="flex h-11 w-11 items-center justify-center rounded-xl font-mono text-[13px] font-medium"
      style={{
        background: item.brand ?? SURFACE_2,
        color: "#FFFFFF",
        letterSpacing: "-0.02em",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.18)",
      }}
    >
      {item.mark}
    </div>
  );
}

function StatusBadge({ status }: { status: Status }) {
  const styles: Record<Status, React.CSSProperties> = {
    live: { background: "rgba(94,234,212,0.10)", color: ACCENT_HOT },
    soon: { background: "rgba(245,158,11,0.10)", color: SOON },
    planned: { background: "rgba(255,255,255,0.06)", color: FG_60 },
  };
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em]"
      style={styles[status]}
    >
      {status === "live" && (
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: ACCENT_HOT }}
        />
      )}
      {STATUS_LABEL[status]}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────
// How it works
// ─────────────────────────────────────────────────────────────
function HowItWorks() {
  const steps = [
    {
      n: "01",
      icon: Plug,
      title: "Conecta a loja e o programa",
      body: "Cola o domínio Shopify e a sua chave da InvoiceXpress. O assistente de 4 passos detecta scopes, regista webhooks e valida credenciais em tempo real.",
      code: [
        "POST  /api/integrations/activate",
        '{ "shopify_domain": "minha-loja.myshopify.com",',
        '  "ix_account":     "minha-empresa" }',
        "200 OK · webhooks registados",
      ],
    },
    {
      n: "02",
      icon: ScrollText,
      title: "Define as regras fiscais",
      body: "IVA incluído ou separado? Razão de isenção por defeito? Série de faturação específica? Tudo no mesmo painel — sem código, sem ficheiros .env.",
      pills: ["IVA incluído", "M99 · Não sujeito", "Série WEB", "Auto-finalizar"],
    },
    {
      n: "03",
      icon: FileText,
      title: "Esquece. A Rioko fatura.",
      body: "Cada encomenda paga gera uma fatura no programa correto, com o NIF do cliente, taxa de IVA certa e texto legal AT incluído. Reembolsos viram nota de crédito. Automático.",
      ticks: [
        "1 encomenda = 1 fatura (idempotência D1 + KV)",
        "Reembolsos → nota de crédito automática",
        "Logs auditáveis por evento",
      ],
    },
  ];

  return (
    <section id="como-funciona" className="relative px-4 pt-32 md:pt-44">
      <div className="mx-auto w-full max-w-[1280px]">
        <SectionHead
          eyebrow="O fluxo"
          title={
            <>
              Três passos. <Mono color={ACCENT_HOT}>Uma vez.</Mono>
            </>
          }
          sub="Configurar a Rioko demora menos do que abrir uma fatura à mão. Depois disso, nunca mais."
        />

        <div className="mt-16 space-y-20">
          {steps.map((s, i) => (
            <Step key={s.n} step={s} flip={i % 2 === 1} />
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
};

function Step({ step, flip }: { step: StepData; flip: boolean }) {
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
            Passo {step.n}
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
            style={{
              ...GLASS,
              background: "rgba(20,24,31,0.7)",
            }}
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
                {/* Terminal chrome */}
                <div
                  className="flex items-center justify-between rounded-t-xl px-3 py-2"
                  style={{
                    background: "rgba(0,0,0,0.4)",
                    border: `1px solid ${HAIRLINE}`,
                    borderBottom: "none",
                  }}
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ background: "rgba(255,255,255,0.18)" }}
                    />
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ background: "rgba(255,255,255,0.18)" }}
                    />
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ background: "rgba(255,255,255,0.18)" }}
                    />
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
                  className="overflow-x-auto rounded-b-xl p-4 font-mono text-[12px] leading-[1.6]"
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
                {["D1", "KV", "HMAC"].map((tag, i) => (
                  <div
                    key={tag}
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
                      {tag}
                    </div>
                    <div
                      className="mt-1 font-mono text-[9px] uppercase tracking-[0.18em]"
                      style={{ color: FG_40 }}
                    >
                      {i === 0
                        ? "atómico"
                        : i === 1
                        ? "rápido"
                        : "verificado"}
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
  const items = [
    {
      icon: ShieldCheck,
      title: "Conformidade AT",
      body: "Texto legal de todas as razões de isenção (M01–M99) injectado em observações da fatura.",
    },
    {
      icon: ScrollText,
      title: "NIF inteligente",
      body: "Detecção de NIF em note_attributes, notas de encomenda e morada de faturação, com validação algorítmica PT.",
    },
    {
      icon: Workflow,
      title: "Idempotência dupla",
      body: "Tabela atómica em D1 + cache KV. Webhooks duplicados, retries de gateway, race conditions — tudo neutralizado.",
    },
    {
      icon: Layers,
      title: "Encriptação em repouso",
      body: "Chaves de API Shopify e InvoiceXpress encriptadas antes de qualquer escrita.",
    },
  ];

  return (
    <section id="fiscal" className="relative px-4 pt-32 md:pt-44">
      <div className="mx-auto w-full max-w-[1280px]">
        <SectionHead
          eyebrow="Confiança"
          title={
            <>
              Feito para fiscalidade portuguesa.
              <br />
              <span style={{ color: FG_60 }}>
                <Mono color={ACCENT_HOT}>Não</Mono> traduzido dela.
              </span>
            </>
          }
          sub="A Rioko nasceu em Lisboa, num escritório fiscal. Não é uma SaaS americana com pacote PT — é o contrário."
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
// Final CTA — only loud-cyan moment
// ─────────────────────────────────────────────────────────────
function FinalCTA() {
  return (
    <section className="relative px-4 pt-32 pb-24 md:pt-44 md:pb-32">
      <div className="mx-auto w-full max-w-[1280px]">
        <div
          className="relative overflow-hidden rounded-[2rem] p-1.5"
          style={{ background: "rgba(2,141,196,0.18)" }}
        >
          <div
            className="relative overflow-hidden rounded-[calc(2rem-0.375rem)] px-8 py-16 md:px-16 md:py-24"
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
                  Pronto?
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
                  Liga a primeira loja em{" "}
                  <Mono color={ACCENT_HOT}>quatro</Mono> minutos.
                </h2>
              </div>
              <div className="md:col-span-5">
                <p
                  className="mb-7 max-w-[40ch] text-[15px] leading-[1.55]"
                  style={{ color: "rgba(240,240,240,0.7)" }}
                >
                  Sem cartão. Sem instalação. Sem extensões no checkout.
                  Configure uma vez, fature para sempre.
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
                    Começar grátis
                    <span
                      className="flex h-8 w-8 items-center justify-center rounded-full transition-transform duration-500 group-hover:translate-x-[2px] group-hover:-translate-y-[1px]"
                      style={{
                        background: "rgba(255,255,255,0.16)",
                        transitionTimingFunction:
                          "cubic-bezier(0.32,0.72,0,1)",
                      }}
                    >
                      <ArrowUpRight
                        className="h-4 w-4"
                        strokeWidth={1.6}
                      />
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
                      Já tenho conta
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
// Footer (Kapta preserved)
// ─────────────────────────────────────────────────────────────
function Footer() {
  return (
    <footer
      className="relative border-t px-4 pb-12 pt-12"
      style={{ borderColor: RULE }}
    >
      <div className="mx-auto flex w-full max-w-[1280px] flex-col items-center gap-6 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
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
            © {new Date().getFullYear()} · todos os direitos reservados
          </span>
        </div>

        <div className="flex items-center gap-6">
          <Link
            href="/privacy"
            className="text-[12px]"
            style={{ color: FG_60 }}
          >
            Privacidade
          </Link>
          <Link
            href="/terms"
            className="text-[12px]"
            style={{ color: FG_60 }}
          >
            Termos
          </Link>
        </div>

        <div className="flex flex-col items-center gap-3">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: FG_40 }}
          >
            Developed by
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
