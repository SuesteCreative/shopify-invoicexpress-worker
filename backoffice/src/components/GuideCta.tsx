import { Link } from "@/i18n/navigation";
import { ArrowRight } from "lucide-react";

/**
 * Reusable end-of-guide call to action. Bilingual-ready (PT default), links to
 * the sign-up flow. Kept a server component (markup + Link only).
 */
export default function GuideCta({ locale }: { locale: string }) {
    const en = locale === "en";
    return (
        <div className="my-12 rounded-[2rem] border border-hairline glass p-8 text-center">
            <h2 className="mb-2 text-2xl font-semibold tracking-tight text-fg">
                {en ? "Automate your invoicing today" : "Automatize a sua faturação hoje"}
            </h2>
            <p className="mx-auto mb-6 max-w-xl text-sm leading-relaxed text-fg-60">
                {en
                    ? "Connect your store and issue a certified invoice for every paid order — no checkout extension, set up in about four minutes."
                    : "Ligue a sua loja e emita uma fatura certificada por cada encomenda paga — sem extensão no checkout, configurado em cerca de quatro minutos."}
            </p>
            <Link
                href="/sign-up"
                className="inline-flex items-center gap-2 rounded-full bg-accent px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-accent-hot"
            >
                {en ? "Create free account" : "Criar conta grátis"}
                <ArrowRight className="h-4 w-4" />
            </Link>
        </div>
    );
}
