export const runtime = "edge";

import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { LangToggle } from "@/components/landing/LangToggle";
import { ThemeToggle } from "@/components/ThemeToggle";

export default function NotFound() {
    const t = useTranslations("notFound");
    return (
        <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4 text-center gap-6">
            <div className="flex items-center gap-2">
                <ThemeToggle />
                <LangToggle />
            </div>
            <h2 className="text-4xl font-black text-fg mb-4">{t("title")}</h2>
            <p className="text-fg-60 mb-8 max-w-md">{t("body")}</p>
            <Link
                href="/"
                className="px-6 py-3 bg-accent hover:bg-accent/85 text-on-accent font-bold rounded-2xl transition-all"
            >
                {t("cta")}
            </Link>
        </div>
    );
}
