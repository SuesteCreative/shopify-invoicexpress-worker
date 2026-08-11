"use client";

import { motion } from "framer-motion";
import { Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * Shown instead of SuspendedBanner when the account is NOT blocked but has no
 * paid Stripe subscription — i.e. an admin-granted early-bird trial or an
 * exempt account. Invoices are being issued normally; the subscribe cards below
 * stay available so the user can start paying whenever they want.
 */
export default function TrialBanner({ trialEnd }: { trialEnd?: string | null }) {
    const t = useTranslations("faturacao");

    const parsed = trialEnd ? new Date(trialEnd) : null;
    const label = parsed && !isNaN(parsed.getTime())
        ? parsed.toLocaleDateString(undefined, { day: "2-digit", month: "long", year: "numeric" })
        : null;

    return (
        <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-start gap-4 px-6 py-5 rounded-2xl border border-[rgba(2,141,196,0.35)] bg-[rgba(2,141,196,0.05)]"
        >
            <span className="w-9 h-9 shrink-0 rounded-xl grid place-items-center bg-[rgba(2,141,196,0.15)] text-accent ring-1 ring-[rgba(2,141,196,0.30)]">
                <Sparkles className="w-5 h-5" />
            </span>
            <div className="min-w-0">
                <p className="text-sm font-black text-accent uppercase tracking-[0.14em]">{t("trialActiveTitle")}</p>
                <p className="text-[12px] text-fg-60 mt-1.5 leading-relaxed">
                    {label ? t("trialActiveBody", { date: label }) : t("trialActiveBodyNoDate")}
                </p>
            </div>
        </motion.div>
    );
}
