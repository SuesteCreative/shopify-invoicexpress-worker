"use client";

import * as React from "react";
import { motion } from "framer-motion";
import Link from "next/link";
import Image from "next/image";
import { useEffect } from "react";
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
// Design tokens (local to landing — overrides global dark theme)
// ─────────────────────────────────────────────────────────────
const PAPER = "#F4F1EA";
const PAPER_DEEP = "#EAE5DA";
const INK = "#0B0E14";
const INK_60 = "rgba(11,14,20,0.62)";
const INK_40 = "rgba(11,14,20,0.42)";
const RULE = "rgba(11,14,20,0.12)";
const HAIRLINE = "rgba(11,14,20,0.08)";
const SAGE = "#2C5E4A";
const AMBER = "#9A6A1F";

const EASE: [number, number, number, number] = [0.32, 0.72, 0, 1];

// ─────────────────────────────────────────────────────────────
// Integration registry
// ─────────────────────────────────────────────────────────────
type Status = "live" | "soon" | "planned";

type Integration = {
  id: string;
  name: string;
  kind: "pagamentos" | "faturação";
  status: Status;
  // Either a real asset (logoSrc) OR a stylised monogram (mark, brand)
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
];

const STATUS_LABEL: Record<Status, string> = {
  live: "Ativo",
  soon: "Em breve",
  planned: "Em estudo",
};

// ─────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────
export default function Landing() {
  // Override global body chrome (which is force-dark in root layout)
  useEffect(() => {
    const prev = {
      bg: document.body.style.backgroundColor,
      color: document.body.style.color,
    };
    document.body.style.backgroundColor = PAPER;
    document.body.style.color = INK;
    return () => {
      document.body.style.backgroundColor = prev.bg;
      document.body.style.color = prev.color;
    };
  }, []);

  return (
    <div
      className="relative min-h-[100dvh] w-full overflow-x-hidden"
      style={{
        backgroundColor: PAPER,
        color: INK,
        "--paper": PAPER,
        "--paper-deep": PAPER_DEEP,
        "--ink": INK,
        "--rule": RULE,
        "--hairline": HAIRLINE,
      } as React.CSSProperties}
    >
      {/* Fixed film-grain overlay (perf-safe: pointer-events-none, fixed) */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-[60] opacity-[0.035] mix-blend-multiply"
        style={{
          backgroundImage:
            'url("data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22220%22 height=%22220%22><filter id=%22n%22><feTurbulence type=%22fractalNoise%22 baseFrequency=%220.9%22 numOctaves=%222%22 stitchTiles=%22stitch%22/></filter><rect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23n)%22/></svg>")',
        }}
      />

      {/* Soft warm wash in the far corners */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0"
        style={{
          backgroundImage: `radial-gradient(60% 40% at 8% 0%, rgba(154,106,31,0.05), transparent 60%),
                            radial-gradient(50% 35% at 100% 100%, rgba(44,94,74,0.05), transparent 60%)`,
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
// Nav — floating glass pill, detached
// ─────────────────────────────────────────────────────────────
function Nav() {
  return (
    <div className="relative z-50 px-4 pt-6 md:pt-8">
      <motion.nav
        initial={{ y: -16, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.7, ease: EASE }}
        className="mx-auto flex w-full max-w-[1280px] items-center justify-between gap-4 rounded-full border px-2 py-2 backdrop-blur-xl"
        style={{
          borderColor: HAIRLINE,
          background: "rgba(244,241,234,0.72)",
          boxShadow:
            "0 1px 0 rgba(255,255,255,0.6) inset, 0 12px 40px -20px rgba(11,14,20,0.18)",
        }}
      >
        <div className="flex items-center gap-3 pl-3">
          <Image
            src="/images/rioko2-logo-black.svg"
            alt="Rioko 2.0"
            width={132}
            height={25}
            priority
          />
          <span
            className="hidden font-mono text-[10px] uppercase tracking-[0.18em] sm:inline-block"
            style={{ color: INK_40 }}
          >
            Engine
          </span>
        </div>

        <div className="hidden items-center gap-7 md:flex">
          <a
            href="#integracoes"
            className="text-[13px] transition-colors hover:opacity-100"
            style={{ color: INK_60 }}
          >
            Integrações
          </a>
          <a
            href="#como-funciona"
            className="text-[13px] transition-colors"
            style={{ color: INK_60 }}
          >
            Como funciona
          </a>
          <a
            href="#fiscal"
            className="text-[13px] transition-colors"
            style={{ color: INK_60 }}
          >
            Conformidade
          </a>
        </div>

        <div className="flex items-center gap-2">
          <Link
            href="/sign-in"
            className="hidden px-4 py-2 text-[13px] sm:inline-block"
            style={{ color: INK }}
          >
            Entrar
          </Link>
          <Link
            href="/sign-up"
            className="group inline-flex items-center gap-2 rounded-full py-2 pl-4 pr-2 text-[13px] font-medium transition-all duration-500 active:scale-[0.98]"
            style={{
              background: INK,
              color: PAPER,
              boxShadow:
                "0 1px 0 rgba(255,255,255,0.08) inset, 0 8px 20px -10px rgba(11,14,20,0.5)",
              transitionTimingFunction: "cubic-bezier(0.32,0.72,0,1)",
            }}
          >
            Começar
            <span
              className="flex h-7 w-7 items-center justify-center rounded-full transition-transform duration-500 group-hover:translate-x-[1px] group-hover:-translate-y-[1px]"
              style={{
                background: "rgba(244,241,234,0.14)",
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
// Hero — editorial split: serif headline + integration showcase
// ─────────────────────────────────────────────────────────────
function Hero() {
  return (
    <section className="relative px-4 pt-14 md:pt-24">
      <div className="mx-auto grid w-full max-w-[1280px] grid-cols-1 gap-12 md:grid-cols-12 md:gap-10">
        {/* LEFT — headline column (7/12) */}
        <div className="md:col-span-7">
          <motion.div
            initial={{ y: 12, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.6, ease: EASE, delay: 0.05 }}
            className="mb-7 inline-flex items-center gap-2 rounded-full border px-3 py-1.5"
            style={{ borderColor: RULE, background: "rgba(255,255,255,0.4)" }}
          >
            <span
              className="relative flex h-1.5 w-1.5 items-center justify-center"
            >
              <span
                className="absolute inset-0 animate-ping rounded-full"
                style={{ background: SAGE, opacity: 0.6 }}
              />
              <span
                className="relative h-1.5 w-1.5 rounded-full"
                style={{ background: SAGE }}
              />
            </span>
            <span
              className="font-mono text-[10px] uppercase tracking-[0.22em]"
              style={{ color: INK_60 }}
            >
              Motor fiscal · Portugal
            </span>
          </motion.div>

          <motion.h1
            initial={{ y: 18, opacity: 0, filter: "blur(6px)" }}
            animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
            transition={{ duration: 0.9, ease: EASE, delay: 0.1 }}
            className="font-[var(--font-editorial)] tracking-[-0.02em]"
            style={{
              fontFamily: "var(--font-editorial), Georgia, serif",
              fontSize: "clamp(3rem, 7vw, 6.5rem)",
              lineHeight: 0.95,
              color: INK,
              textWrap: "balance" as const,
            }}
          >
            Uma fatura.<br />
            Para <em style={{ fontStyle: "italic", color: INK }}>cada</em>{" "}
            encomenda.<br />
            <span style={{ color: INK_60 }}>
              De <em style={{ fontStyle: "italic" }}>cada</em> plataforma.
            </span>
          </motion.h1>

          <motion.p
            initial={{ y: 12, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.7, ease: EASE, delay: 0.25 }}
            className="mt-7 max-w-[52ch] text-[16px] leading-[1.55]"
            style={{ color: INK_60 }}
          >
            Rioko é o motor que conecta a sua loja, o seu gateway de pagamento
            e o seu programa de faturação. Webhook entra,{" "}
            <span style={{ color: INK }}>fatura sai</span> — em menos de um
            segundo, com NIF detectado, IVA calculado e isenção fiscal aplicada
            conforme o código M01–M99.
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
                background: INK,
                color: PAPER,
                transitionTimingFunction: "cubic-bezier(0.32,0.72,0,1)",
                boxShadow:
                  "0 1px 0 rgba(255,255,255,0.08) inset, 0 14px 30px -16px rgba(11,14,20,0.55)",
              }}
            >
              Criar conta grátis
              <span
                className="flex h-8 w-8 items-center justify-center rounded-full transition-transform duration-500 group-hover:translate-x-[2px] group-hover:-translate-y-[1px]"
                style={{
                  background: "rgba(244,241,234,0.14)",
                  transitionTimingFunction: "cubic-bezier(0.32,0.72,0,1)",
                }}
              >
                <ArrowUpRight className="h-4 w-4" strokeWidth={1.6} />
              </span>
            </Link>

            <a
              href="#integracoes"
              className="group inline-flex items-center gap-2 text-[14px]"
              style={{ color: INK }}
            >
              <span
                className="border-b transition-[border-color]"
                style={{ borderColor: RULE }}
              >
                Ver integrações disponíveis
              </span>
              <ArrowRight
                className="h-3.5 w-3.5 transition-transform duration-500 group-hover:translate-x-1"
                strokeWidth={1.6}
              />
            </a>
          </motion.div>

          {/* Live counters strip */}
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

        {/* RIGHT — integration showcase (5/12) */}
        <div className="md:col-span-5">
          <HeroShowcase />
        </div>
      </div>
    </section>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <div
        className="font-mono text-[22px] tabular-nums"
        style={{ color: INK, letterSpacing: "-0.01em" }}
      >
        {value}
      </div>
      <div
        className="mt-1 text-[10px] uppercase tracking-[0.18em]"
        style={{ color: INK_40 }}
      >
        {label}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Hero showcase — double-bezel card with live flow
// ─────────────────────────────────────────────────────────────
function HeroShowcase() {
  return (
    <motion.div
      initial={{ y: 24, opacity: 0, filter: "blur(8px)" }}
      animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
      transition={{ duration: 1, ease: EASE, delay: 0.3 }}
      className="relative"
    >
      {/* Outer shell (Doppelrand) */}
      <div
        className="rounded-[2.25rem] p-1.5"
        style={{
          background: "rgba(11,14,20,0.04)",
          boxShadow: "0 1px 0 rgba(255,255,255,0.6) inset",
        }}
      >
        {/* Inner core */}
        <div
          className="overflow-hidden rounded-[calc(2.25rem-0.375rem)] p-6"
          style={{
            background:
              "linear-gradient(180deg, #FBF9F4 0%, #F4F1EA 100%)",
            boxShadow:
              "0 1px 0 rgba(255,255,255,0.7) inset, 0 30px 60px -30px rgba(11,14,20,0.18)",
            border: "1px solid " + HAIRLINE,
          }}
        >
          {/* Top row — origin platform */}
          <FlowCard
            label="Origem"
            title="Shopify"
            sub="encomenda paga · #1042"
            asset="/images/shopify-logo.webp"
            delay={0.5}
          />

          {/* Connector — animated dotted line */}
          <FlowConnector delay={0.7} />

          {/* Middle row — Rioko engine */}
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: EASE, delay: 0.9 }}
            className="relative rounded-2xl p-4"
            style={{
              background: INK,
              color: PAPER,
              boxShadow:
                "0 1px 0 rgba(255,255,255,0.06) inset, 0 12px 30px -16px rgba(11,14,20,0.55)",
            }}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div
                  className="flex h-9 w-9 items-center justify-center rounded-full"
                  style={{ background: "rgba(244,241,234,0.08)" }}
                >
                  <Workflow
                    className="h-4 w-4"
                    style={{ color: PAPER }}
                    strokeWidth={1.5}
                  />
                </div>
                <div>
                  <div className="text-[13px] font-medium">
                    Rioko Engine
                  </div>
                  <div
                    className="font-mono text-[10px] uppercase tracking-[0.18em]"
                    style={{ color: "rgba(244,241,234,0.5)" }}
                  >
                    NIF · IVA · Isenção · Cliente
                  </div>
                </div>
              </div>
              <div
                className="font-mono text-[10px] tabular-nums"
                style={{ color: "rgba(244,241,234,0.6)" }}
              >
                347 ms
              </div>
            </div>

            {/* Mini pipeline ticks */}
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
                  style={{ background: "rgba(244,241,234,0.06)" }}
                >
                  <Check
                    className="h-3 w-3"
                    style={{ color: "#86C9A4" }}
                    strokeWidth={2}
                  />
                  <span
                    className="font-mono text-[10px]"
                    style={{ color: "rgba(244,241,234,0.85)" }}
                  >
                    {step}
                  </span>
                </motion.div>
              ))}
            </div>
          </motion.div>

          <FlowConnector delay={1.3} />

          {/* Bottom row — destination */}
          <FlowCard
            label="Destino"
            title="InvoiceXpress"
            sub="FT 2026/A/847 · finalizada"
            asset="/images/invoicexpress_logo2.png"
            delay={1.5}
            tone="success"
          />

          {/* Footer caption */}
          <div
            className="mt-5 flex items-center justify-between border-t pt-4 text-[11px]"
            style={{ borderColor: HAIRLINE, color: INK_40 }}
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

      {/* Floating offset stamp */}
      <motion.div
        initial={{ opacity: 0, rotate: -6, y: 12 }}
        animate={{ opacity: 1, rotate: -6, y: 0 }}
        transition={{ duration: 0.8, ease: EASE, delay: 1.7 }}
        className="absolute -bottom-5 -left-5 hidden rounded-full border px-3 py-1.5 md:inline-flex"
        style={{
          borderColor: RULE,
          background: PAPER,
          color: SAGE,
          boxShadow: "0 10px 24px -12px rgba(11,14,20,0.2)",
        }}
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.22em]">
          1 encomenda · 1 fatura · sempre
        </span>
      </motion.div>
    </motion.div>
  );
}

function FlowCard({
  label,
  title,
  sub,
  asset,
  delay,
  tone,
}: {
  label: string;
  title: string;
  sub: string;
  asset: string;
  delay: number;
  tone?: "success";
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: EASE, delay }}
      className="flex items-center justify-between rounded-2xl border p-4"
      style={{
        borderColor: HAIRLINE,
        background: "#FFFFFF",
        boxShadow: "0 1px 0 rgba(255,255,255,0.8) inset",
      }}
    >
      <div className="flex items-center gap-3">
        <div
          className="flex h-9 w-9 items-center justify-center rounded-xl"
          style={{ background: PAPER_DEEP, border: "1px solid " + HAIRLINE }}
        >
          <Image
            src={asset}
            alt=""
            width={20}
            height={20}
            className="object-contain"
          />
        </div>
        <div>
          <div
            className="font-mono text-[10px] uppercase tracking-[0.18em]"
            style={{ color: INK_40 }}
          >
            {label}
          </div>
          <div className="text-[14px] font-medium" style={{ color: INK }}>
            {title}
          </div>
        </div>
      </div>
      <div className="text-right">
        <div
          className="font-mono text-[11px] tabular-nums"
          style={{ color: INK_60 }}
        >
          {sub}
        </div>
        {tone === "success" && (
          <div
            className="mt-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5"
            style={{
              background: "rgba(44,94,74,0.08)",
              color: SAGE,
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
          backgroundImage: `repeating-linear-gradient(180deg, ${INK_40} 0 2px, transparent 2px 6px)`,
        }}
      />
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────
// Integration Matrix — THE section the old page was missing
// ─────────────────────────────────────────────────────────────
function IntegrationMatrix() {
  const pagamentos = INTEGRATIONS.filter((i) => i.kind === "pagamentos");
  const faturação = INTEGRATIONS.filter((i) => i.kind === "faturação");

  return (
    <section
      id="integracoes"
      className="relative px-4 pt-32 md:pt-44"
    >
      <div className="mx-auto w-full max-w-[1280px]">
        <SectionHead
          eyebrow="O hub"
          title={
            <>
              Cada plataforma fala com a&nbsp;
              <em style={{ fontStyle: "italic" }}>Rioko</em>.
              <br />A Rioko fala com&nbsp;
              <em style={{ fontStyle: "italic" }}>cada</em> programa de
              faturação.
            </>
          }
          sub="Em vez de manter sete integrações ponto-a-ponto, mantém uma. Adicionamos pagamentos e programas de faturação ao motor à medida que o ecossistema cresce."
        />

        {/* Pagamentos row */}
        <IntegrationGroup
          kind="Pagamentos"
          subtitle="entrada · pedidos pagos chegam por webhook"
          items={pagamentos}
        />

        <div
          className="my-14 h-px w-full"
          style={{ background: RULE }}
        />

        {/* Faturação row */}
        <IntegrationGroup
          kind="Faturação"
          subtitle="saída · documentos emitidos ao gateway certo"
          items={faturação}
        />

        {/* Roadmap line */}
        <div
          className="mt-16 flex flex-wrap items-center justify-between gap-4 rounded-2xl border px-5 py-4"
          style={{
            borderColor: RULE,
            background: "rgba(255,255,255,0.45)",
          }}
        >
          <div className="flex items-center gap-3">
            <Layers
              className="h-4 w-4"
              style={{ color: INK_60 }}
              strokeWidth={1.5}
            />
            <div>
              <div className="text-[13px]" style={{ color: INK }}>
                Falta uma integração que precisa?
              </div>
              <div
                className="font-mono text-[10px] uppercase tracking-[0.18em]"
                style={{ color: INK_40 }}
              >
                priorizamos por procura real
              </div>
            </div>
          </div>
          <a
            href="mailto:rioko@kapta.pt?subject=Pedido%20de%20integração"
            className="group inline-flex items-center gap-2 text-[13px]"
            style={{ color: INK }}
          >
            <span
              className="border-b"
              style={{ borderColor: RULE }}
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
        <h3
          className="text-[14px] font-medium"
          style={{ color: INK }}
        >
          {kind}
        </h3>
        <span
          className="font-mono text-[10px] uppercase tracking-[0.18em]"
          style={{ color: INK_40 }}
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
      className="group relative rounded-[1.5rem] p-1.5"
      style={{
        background: isLive ? "rgba(11,14,20,0.05)" : "rgba(11,14,20,0.025)",
      }}
    >
      <div
        className="relative h-full overflow-hidden rounded-[calc(1.5rem-0.375rem)] p-5"
        style={{
          background: "#FFFFFF",
          border: "1px solid " + HAIRLINE,
          boxShadow:
            "0 1px 0 rgba(255,255,255,0.7) inset, 0 18px 40px -28px rgba(11,14,20,0.15)",
        }}
      >
        <div className="flex items-start justify-between">
          <Mark item={item} />
          <StatusBadge status={item.status} />
        </div>

        <div className="mt-6">
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
            {item.note}
          </div>
        </div>

        {!isLive && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-[calc(1.5rem-0.375rem)]"
            style={{
              background:
                "repeating-linear-gradient(135deg, rgba(11,14,20,0.02) 0 6px, transparent 6px 12px)",
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
          background: PAPER_DEEP,
          border: "1px solid " + HAIRLINE,
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
        background: item.brand ?? INK,
        color: "#FFFFFF",
        letterSpacing: "-0.02em",
      }}
    >
      {item.mark}
    </div>
  );
}

function StatusBadge({ status }: { status: Status }) {
  const styles: Record<Status, React.CSSProperties> = {
    live: { background: "rgba(44,94,74,0.08)", color: SAGE },
    soon: { background: "rgba(154,106,31,0.08)", color: AMBER },
    planned: { background: "rgba(11,14,20,0.06)", color: INK_60 },
  };
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em]"
      style={styles[status]}
    >
      {status === "live" && (
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: SAGE }}
        />
      )}
      {STATUS_LABEL[status]}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────
// How it works — 3 zig-zag steps (no 3-col card cliché)
// ─────────────────────────────────────────────────────────────
function HowItWorks() {
  const steps = [
    {
      n: "01",
      icon: Plug,
      title: "Conecta a loja e o programa",
      body: "Cole o domínio Shopify e a sua chave da InvoiceXpress. O assistente de 4 passos detecta scopes, regista webhooks e valida credenciais em tempo real.",
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
    <section
      id="como-funciona"
      className="relative px-4 pt-32 md:pt-44"
    >
      <div className="mx-auto w-full max-w-[1280px]">
        <SectionHead
          eyebrow="O fluxo"
          title={
            <>
              Três passos. <em style={{ fontStyle: "italic" }}>Uma vez.</em>
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
      {/* Number + text */}
      <div className={"md:col-span-6 " + (flip ? "md:order-2" : "")}>
        <div className="flex items-center gap-3">
          <span
            className="font-mono text-[11px] uppercase tracking-[0.24em]"
            style={{ color: INK_40 }}
          >
            Passo {step.n}
          </span>
          <span
            className="h-px flex-1"
            style={{ background: RULE }}
          />
        </div>
        <h3
          className="mt-5 tracking-[-0.02em]"
          style={{
            fontFamily: "var(--font-editorial), Georgia, serif",
            fontSize: "clamp(2rem, 3.4vw, 3rem)",
            lineHeight: 1.02,
            color: INK,
          }}
        >
          {step.title}
        </h3>
        <p
          className="mt-5 max-w-[52ch] text-[15px] leading-[1.6]"
          style={{ color: INK_60 }}
        >
          {step.body}
        </p>

        {step.ticks && (
          <ul className="mt-6 space-y-2.5">
            {step.ticks.map((t) => (
              <li
                key={t}
                className="flex items-start gap-2.5 text-[14px]"
                style={{ color: INK }}
              >
                <span
                  className="mt-1.5 inline-flex h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: SAGE }}
                />
                {t}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Visual */}
      <div className={"md:col-span-6 " + (flip ? "md:order-1" : "")}>
        <div
          className="rounded-[2rem] p-1.5"
          style={{ background: "rgba(11,14,20,0.04)" }}
        >
          <div
            className="overflow-hidden rounded-[calc(2rem-0.375rem)] border p-6"
            style={{
              borderColor: HAIRLINE,
              background: "#FFFFFF",
              boxShadow:
                "0 1px 0 rgba(255,255,255,0.75) inset, 0 24px 48px -28px rgba(11,14,20,0.18)",
            }}
          >
            <div className="flex items-center justify-between">
              <div
                className="flex h-10 w-10 items-center justify-center rounded-xl"
                style={{
                  background: PAPER_DEEP,
                  border: "1px solid " + HAIRLINE,
                }}
              >
                <Icon
                  className="h-4 w-4"
                  strokeWidth={1.5}
                />
              </div>
              <span
                className="font-mono text-[10px] uppercase tracking-[0.18em]"
                style={{ color: INK_40 }}
              >
                {step.n}
              </span>
            </div>

            {step.code && (
              <pre
                className="mt-6 overflow-x-auto rounded-xl p-4 font-mono text-[12px] leading-[1.6]"
                style={{
                  background: INK,
                  color: PAPER,
                  boxShadow:
                    "0 1px 0 rgba(255,255,255,0.08) inset",
                }}
              >
                {step.code.map((line, i) => (
                  <div
                    key={i}
                    style={{
                      color:
                        i === 0
                          ? "#86C9A4"
                          : i === step.code!.length - 1
                          ? "#86C9A4"
                          : "rgba(244,241,234,0.78)",
                    }}
                  >
                    {line}
                  </div>
                ))}
              </pre>
            )}

            {step.pills && (
              <div className="mt-6 flex flex-wrap gap-2">
                {step.pills.map((p) => (
                  <span
                    key={p}
                    className="rounded-full border px-3 py-1.5 text-[12px]"
                    style={{
                      borderColor: HAIRLINE,
                      background: PAPER,
                      color: INK,
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
                      background: PAPER_DEEP,
                      border: "1px solid " + HAIRLINE,
                    }}
                  >
                    <div
                      className="font-mono text-[11px]"
                      style={{ color: INK }}
                    >
                      {tag}
                    </div>
                    <div
                      className="mt-1 font-mono text-[9px] uppercase tracking-[0.18em]"
                      style={{ color: INK_40 }}
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
// Fiscal trust — Portuguese context
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
    <section
      id="fiscal"
      className="relative px-4 pt-32 md:pt-44"
    >
      <div className="mx-auto w-full max-w-[1280px]">
        <SectionHead
          eyebrow="Confiança"
          title={
            <>
              Feito para fiscalidade portuguesa.
              <br />
              <span style={{ color: INK_60 }}>
                <em style={{ fontStyle: "italic" }}>Não</em> traduzido dela.
              </span>
            </>
          }
          sub="A Rioko nasceu em Lisboa, num escritório fiscal. Não é uma SaaS americana com pacote PT — é o contrário."
        />

        <div className="mt-14 grid grid-cols-1 gap-px overflow-hidden rounded-[2rem] border md:grid-cols-2"
          style={{ borderColor: HAIRLINE, background: RULE }}
        >
          {items.map((it) => (
            <div
              key={it.title}
              className="p-8 md:p-10"
              style={{ background: "#FFFFFF" }}
            >
              <it.icon
                className="h-5 w-5"
                style={{ color: INK }}
                strokeWidth={1.5}
              />
              <h4
                className="mt-5 text-[18px] font-medium tracking-tight"
                style={{ color: INK }}
              >
                {it.title}
              </h4>
              <p
                className="mt-2 max-w-[42ch] text-[14px] leading-[1.55]"
                style={{ color: INK_60 }}
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
// Final CTA
// ─────────────────────────────────────────────────────────────
function FinalCTA() {
  return (
    <section className="relative px-4 pt-32 pb-24 md:pt-44 md:pb-32">
      <div className="mx-auto w-full max-w-[1280px]">
        <div
          className="relative overflow-hidden rounded-[2.5rem] p-1.5"
          style={{ background: "rgba(11,14,20,0.06)" }}
        >
          <div
            className="relative overflow-hidden rounded-[calc(2.5rem-0.375rem)] px-8 py-16 md:px-16 md:py-24"
            style={{
              background: INK,
              color: PAPER,
              boxShadow:
                "0 1px 0 rgba(255,255,255,0.06) inset",
            }}
          >
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{
                backgroundImage:
                  "radial-gradient(50% 60% at 20% 0%, rgba(244,241,234,0.07), transparent 60%), radial-gradient(40% 50% at 90% 100%, rgba(134,201,164,0.08), transparent 60%)",
              }}
            />

            <div className="relative grid grid-cols-1 items-end gap-10 md:grid-cols-12 md:gap-10">
              <div className="md:col-span-7">
                <span
                  className="font-mono text-[10px] uppercase tracking-[0.22em]"
                  style={{ color: "rgba(244,241,234,0.55)" }}
                >
                  Pronto?
                </span>
                <h2
                  className="mt-4 tracking-[-0.02em]"
                  style={{
                    fontFamily:
                      "var(--font-editorial), Georgia, serif",
                    fontSize: "clamp(2.5rem, 5vw, 4.75rem)",
                    lineHeight: 0.98,
                  }}
                >
                  Liga a primeira loja em&nbsp;
                  <em style={{ fontStyle: "italic" }}>quatro</em> minutos.
                </h2>
              </div>
              <div className="md:col-span-5">
                <p
                  className="mb-7 max-w-[40ch] text-[15px] leading-[1.55]"
                  style={{ color: "rgba(244,241,234,0.7)" }}
                >
                  Sem cartão. Sem instalação. Sem extensões no checkout.
                  Configure uma vez, fature para sempre.
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  <Link
                    href="/sign-up"
                    className="group inline-flex items-center gap-2 rounded-full py-3 pl-6 pr-2 text-[14px] font-medium transition-transform duration-500 active:scale-[0.98]"
                    style={{
                      background: PAPER,
                      color: INK,
                      transitionTimingFunction:
                        "cubic-bezier(0.32,0.72,0,1)",
                    }}
                  >
                    Começar grátis
                    <span
                      className="flex h-8 w-8 items-center justify-center rounded-full transition-transform duration-500 group-hover:translate-x-[2px] group-hover:-translate-y-[1px]"
                      style={{
                        background: "rgba(11,14,20,0.08)",
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
                    style={{ color: "rgba(244,241,234,0.8)" }}
                  >
                    <span
                      className="border-b"
                      style={{ borderColor: "rgba(244,241,234,0.25)" }}
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
// Footer (Kapta — preserved, polished)
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
            src="/images/rioko2-logo-black.svg"
            alt="Rioko 2.0"
            width={110}
            height={21}
          />
          <span
            className="font-mono text-[10px] uppercase tracking-[0.2em]"
            style={{ color: INK_40 }}
          >
            © {new Date().getFullYear()} · todos os direitos reservados
          </span>
        </div>

        <div className="flex items-center gap-6">
          <Link
            href="/privacy"
            className="text-[12px]"
            style={{ color: INK_60 }}
          >
            Privacidade
          </Link>
          <Link
            href="/terms"
            className="text-[12px]"
            style={{ color: INK_60 }}
          >
            Termos
          </Link>
        </div>

        <div className="flex flex-col items-center gap-3">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: INK_40 }}
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
              className="opacity-80"
              style={{ filter: "invert(1)" }}
            />
          </a>
        </div>
      </div>
    </footer>
  );
}

// ─────────────────────────────────────────────────────────────
// Section head (shared)
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
          className="inline-flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.22em]"
          style={{ borderColor: RULE, color: INK_60 }}
        >
          <span
            className="h-1 w-1 rounded-full"
            style={{ background: INK }}
          />
          {eyebrow}
        </span>
        <h2
          className="mt-6 tracking-[-0.02em]"
          style={{
            fontFamily: "var(--font-editorial), Georgia, serif",
            fontSize: "clamp(2.25rem, 4vw, 3.75rem)",
            lineHeight: 1.02,
            color: INK,
          }}
        >
          {title}
        </h2>
      </div>
      <div className="md:col-span-6 md:col-start-7">
        <p
          className="max-w-[52ch] text-[15px] leading-[1.6] md:mt-14"
          style={{ color: INK_60 }}
        >
          {sub}
        </p>
      </div>
    </div>
  );
}
