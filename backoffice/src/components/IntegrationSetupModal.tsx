"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Calendar, Mail } from "lucide-react";

const DISMISSED_KEY = "rioko_setup_modal_dismissed";

// ─── Brand tokens (docs/brand-guideline.md) ────────────────────────────────
const SURFACE   = "#0E1116";
const HAIRLINE  = "rgba(255,255,255,0.06)";
const RULE      = "rgba(255,255,255,0.08)";
const FG        = "#F0F0F0";
const FG_60     = "rgba(240,240,240,0.62)";
const FG_40     = "rgba(240,240,240,0.40)";
const ACCENT    = "#028DC4";
const ACCENT_HOT = "#5EEAD4";

// Single canonical easing — [0.32, 0.72, 0, 1]
const EASE: [number, number, number, number] = [0.32, 0.72, 0, 1];

export function IntegrationSetupModal() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(DISMISSED_KEY)) return;
    } catch {
      return; // localStorage unavailable (SSR guard)
    }

    fetch("/api/integrations")
      .then((res) => res.json())
      .then((data: any) => {
        const isRegistered = !!data._registration_completed;
        // Complete only when Shopify, InvoiceXpress, and webhooks are all live
        const isComplete =
          data.shopify_authorized === 1 &&
          data.ix_authorized === 1 &&
          data.webhooks_active === 1;

        if (isRegistered && !isComplete) {
          setVisible(true);
        }
      })
      .catch(() => {
        // Never block the user over a modal — silent fail
      });
  }, []);

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, "true");
    } catch { /* ignore */ }
    setVisible(false);
  };

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 14, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 14, scale: 0.97 }}
          transition={{ duration: 0.5, ease: EASE, delay: 1.2 }}
          className="fixed bottom-6 right-6 z-50 w-full max-w-[310px]"
        >
          {/* Double-bezel shell (Doppelrand) — gives the card visual weight */}
          <div
            className="rounded-[1.625rem] p-px"
            style={{ background: "rgba(255,255,255,0.05)" }}
          >
            <div
              className="rounded-[calc(1.625rem-1px)] overflow-hidden relative"
              style={{
                background: SURFACE,
                border: `1px solid ${HAIRLINE}`,
                backdropFilter: "blur(20px)",
                WebkitBackdropFilter: "blur(20px)",
                boxShadow: [
                  "inset 0 1px 0 rgba(255,255,255,0.06)",
                  "0 24px 48px -28px rgba(0,0,0,0.72)",
                ].join(", "),
              }}
            >
              {/* Close button */}
              <button
                onClick={dismiss}
                aria-label="Fechar"
                className="absolute top-3.5 right-3.5 w-6 h-6 rounded-lg flex items-center justify-center cursor-pointer"
                style={{
                  color: FG_40,
                  transition: `color 500ms cubic-bezier(${EASE.join(",")})`,
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.color = FG)
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.color = FG_40)
                }
              >
                <X strokeWidth={1.5} className="w-3.5 h-3.5" />
              </button>

              <div className="p-5 space-y-4">
                {/* Eyebrow pill */}
                <span
                  className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] font-mono text-[10px] uppercase tracking-[0.22em]"
                  style={{
                    border: `1px solid ${RULE}`,
                    background: "rgba(255,255,255,0.02)",
                    color: FG_40,
                  }}
                >
                  {/* Live-style mint dot */}
                  <span
                    className="h-1 w-1 rounded-full shrink-0"
                    style={{ background: ACCENT_HOT }}
                  />
                  Configuração Pendente
                </span>

                {/* Title + body */}
                <div className="space-y-1.5 pr-5">
                  <h3
                    className="text-[15px] font-medium leading-snug"
                    style={{ color: FG, letterSpacing: "-0.015em" }}
                  >
                    Precisa de ajuda com a integração?
                  </h3>
                  <p
                    className="text-[13px] leading-relaxed"
                    style={{ color: FG_60 }}
                  >
                    A sua integração ainda não está completa. A nossa equipa
                    pode ajudá-lo a concluir o processo em minutos.
                  </p>
                </div>

                {/* Hairline divider */}
                <div style={{ height: "1px", background: HAIRLINE }} />

                {/* CTA buttons — pill style with trailing icon circle */}
                <div className="space-y-2">
                  {/* Primary: Schedule meeting */}
                  <a
                    href="https://calendly.com/pedro-kapta/apoio-kapta"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex items-center justify-between w-full rounded-full py-2.5 pl-5 pr-1.5 active:scale-[0.98]"
                    style={{
                      background: ACCENT,
                      color: "#ffffff",
                      boxShadow: [
                        "inset 0 1px 0 rgba(255,255,255,0.15)",
                        "0 0 28px -10px rgba(2,141,196,0.45)",
                      ].join(", "),
                      transition: `transform 200ms cubic-bezier(${EASE.join(",")})`,
                    }}
                  >
                    <span className="font-mono text-[11px] uppercase tracking-[0.18em]">
                      Agendar Reunião
                    </span>
                    <span
                      className="h-7 w-7 rounded-full flex items-center justify-center transition-transform duration-500 group-hover:translate-x-[1px] group-hover:-translate-y-[1px]"
                      style={{ background: "rgba(255,255,255,0.18)" }}
                    >
                      <Calendar strokeWidth={1.5} className="w-3.5 h-3.5" />
                    </span>
                  </a>

                  {/* Secondary: Email */}
                  <a
                    href="mailto:pedro@kapta.pt"
                    className="group flex items-center justify-between w-full rounded-full py-2.5 pl-5 pr-1.5 active:scale-[0.98]"
                    style={{
                      background: "rgba(255,255,255,0.03)",
                      border: `1px solid ${HAIRLINE}`,
                      color: FG_60,
                      transition: `transform 200ms cubic-bezier(${EASE.join(",")})`,
                    }}
                  >
                    <span className="font-mono text-[11px] uppercase tracking-[0.18em]">
                      Enviar Email
                    </span>
                    <span
                      className="h-7 w-7 rounded-full flex items-center justify-center transition-transform duration-500 group-hover:translate-x-[1px] group-hover:-translate-y-[1px]"
                      style={{ background: "rgba(255,255,255,0.06)" }}
                    >
                      <Mail strokeWidth={1.5} className="w-3.5 h-3.5" />
                    </span>
                  </a>
                </div>

                {/* Soft dismiss link */}
                <button
                  onClick={dismiss}
                  className="w-full text-center font-mono text-[10px] uppercase tracking-[0.18em] cursor-pointer"
                  style={{
                    color: FG_40,
                    transition: `color 500ms cubic-bezier(${EASE.join(",")})`,
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.color = FG_60)
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.color = FG_40)
                  }
                >
                  Não mostrar novamente
                </button>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
