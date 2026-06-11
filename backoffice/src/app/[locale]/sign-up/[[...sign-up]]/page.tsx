import { SignUp } from "@clerk/nextjs";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { LangToggle } from "@/components/landing/LangToggle";

export const runtime = "edge";

export default async function Page({
    params,
}: {
    params: Promise<{ locale: string }>;
}) {
    const { locale } = await params;
    const t = await getTranslations({ locale, namespace: "landing.footer" });
    return (
        <div className="flex flex-col items-center justify-center min-h-screen gap-6 bg-slate-950 p-4">
            <LangToggle variant="dark" />
            <div className="w-full max-w-[440px] flex justify-center">
                <SignUp
                    path={`/${locale}/sign-up`}
                    signInUrl={`/${locale}/sign-in`}
                    forceRedirectUrl={`/${locale}/dashboard`}
                    appearance={{
                        layout: {
                            logoImageUrl: "/images/rioko2-logo-black.svg",
                            logoPlacement: "inside",
                        },
                        elements: {
                            logoImage: "h-7 w-auto",
                        },
                    }}
                />
            </div>
            <div className="flex items-center gap-3 text-xs text-slate-500">
                <Link href="/privacy" className="hover:text-slate-300 transition-colors">
                    {t("privacy")}
                </Link>
                <span className="text-slate-700">·</span>
                <Link href="/terms" className="hover:text-slate-300 transition-colors">
                    {t("terms")}
                </Link>
            </div>
        </div>
    );
}
