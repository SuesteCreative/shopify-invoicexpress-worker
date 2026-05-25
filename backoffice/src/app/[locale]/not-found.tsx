export const runtime = "edge";

import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { LangToggle } from "@/components/landing/LangToggle";

export default function NotFound() {
    const t = useTranslations("notFound");
    return (
        <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-4 text-center gap-6">
            <LangToggle variant="dark" />
            <h2 className="text-4xl font-black text-white mb-4">{t("title")}</h2>
            <p className="text-slate-400 mb-8 max-w-md">{t("body")}</p>
            <Link
                href="/"
                className="px-6 py-3 bg-sky-500 hover:bg-sky-400 text-white font-bold rounded-2xl transition-all"
            >
                {t("cta")}
            </Link>
        </div>
    );
}
