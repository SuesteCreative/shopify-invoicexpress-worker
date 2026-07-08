"use client";

import { motion } from "framer-motion";
import { AlertTriangle } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * Suspended-account notice shown above the "Activate subscription" cards for any
 * non-early-bird user without an active subscription. Communicates that the
 * system is suspended (no invoices issued) until they subscribe. Styling matches
 * the "blocked" state of SubscriptionCard (red/destructive) for consistency.
 */
export default function SuspendedBanner() {
    const t = useTranslations("faturacao");
    return (
        <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-start gap-4 px-6 py-5 rounded-2xl border border-[rgba(244,63,94,0.40)] bg-[rgba(244,63,94,0.05)]"
        >
            <span className="w-9 h-9 shrink-0 rounded-xl grid place-items-center bg-[rgba(244,63,94,0.15)] text-destructive ring-1 ring-[rgba(244,63,94,0.30)]">
                <AlertTriangle className="w-5 h-5" />
            </span>
            <div className="min-w-0">
                <p className="text-sm font-black text-destructive uppercase tracking-[0.14em]">{t("suspendedTitle")}</p>
                <p className="text-[12px] text-fg-60 mt-1.5 leading-relaxed">{t("suspendedBody")}</p>
            </div>
        </motion.div>
    );
}
