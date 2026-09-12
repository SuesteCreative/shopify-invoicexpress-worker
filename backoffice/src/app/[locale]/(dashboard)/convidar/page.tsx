"use client";

export const runtime = "edge";

import { useTranslations } from "next-intl";
import { ReferralCard } from "@/components/ReferralCard";

export default function ConvidarPage() {
    const t = useTranslations("referral");
    return (
        <div className="p-4 sm:p-8 max-w-3xl mx-auto space-y-6">
            <header>
                <h1 className="text-2xl font-medium tracking-tight text-fg">{t("pageTitle")}</h1>
                <p className="mt-1 text-sm text-fg-60">{t("pageSubtitle")}</p>
            </header>
            <ReferralCard />
        </div>
    );
}
