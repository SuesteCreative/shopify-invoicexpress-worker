import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ChangelogList } from "@/components/ChangelogList";
import { CHANGELOG_PUBLIC } from "@/lib/changelog.generated";
import { RIOKO_CONFIG } from "@/lib/config";

export const runtime = "edge";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("changelogPage");
    return { title: `${t("title")} · Rioko`, robots: { index: false } };
}

/**
 * What the merchant reads. Only releases that wrote a "Para o comerciante"
 * section appear, and only those lines: a refactor or an admin panel is a
 * release they are never shown. The full history lives at /admin/changelog.
 */
export default async function ChangelogPage() {
    const t = await getTranslations("changelogPage");

    return (
        <div className="max-w-3xl">
            <header className="mb-10">
                <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-fg-40">
                    {t("eyebrow")}
                </div>
                <h1 className="mt-2 text-3xl md:text-4xl font-display text-fg">{t("title")}</h1>
                <p className="mt-3 text-sm text-fg-60 leading-relaxed">{t("subtitle")}</p>
                <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-hairline px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-fg-60">
                    <span className="w-1.5 h-1.5 rounded-full bg-accent-ink" />
                    {t("running", { version: RIOKO_CONFIG.version })}
                </div>
            </header>

            <ChangelogList
                entries={CHANGELOG_PUBLIC}
                labels={{
                    highlight: t("highlight"),
                    untitled: t("untitled"),
                    commit: (sha) => t("commit", { sha }),
                }}
            />
        </div>
    );
}
