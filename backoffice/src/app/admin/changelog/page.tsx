export const runtime = "edge";
export const dynamic = "force-dynamic";

import { ChangelogList } from "@/components/ChangelogList";
import { CHANGELOG, CHANGELOG_PUBLIC } from "@/lib/changelog.generated";
import { RIOKO_CONFIG } from "@/lib/config";

// No role check here: app/admin/layout.tsx gates the whole tree.

/**
 * Every release, in full. The merchant page shows the subset with a
 * "Para o comerciante" section — the count below says how big that subset is,
 * because a release that told the merchant nothing is a deliberate choice, not
 * an oversight to be discovered later.
 */
export default function AdminChangelogPage() {
    const silent = CHANGELOG.length - CHANGELOG_PUBLIC.length;

    return (
        <div className="max-w-3xl">
            <header className="mb-10">
                <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-fg-40">
                    Rioko
                </div>
                <h1 className="mt-2 text-3xl md:text-4xl font-display text-fg">Notas de versão</h1>
                <p className="mt-3 text-sm text-fg-60 leading-relaxed">
                    Todas as versões, com as notas internas. O comerciante vê{" "}
                    {CHANGELOG_PUBLIC.length} delas, e só as linhas escritas para ele; {silent} são
                    silenciosas. Escreve-se no <code className="font-mono text-[0.85em]">CHANGELOG.md</code>, ou
                    por trailer <code className="font-mono text-[0.85em]">Notas:</code> no commit.
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                    <span className="inline-flex items-center gap-2 rounded-full border border-hairline px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-fg-60">
                        <span className="w-1.5 h-1.5 rounded-full bg-accent-ink" />
                        em produção: v{RIOKO_CONFIG.version}
                    </span>
                    <a
                        href="/pt/changelog"
                        className="font-mono text-[10px] uppercase tracking-[0.18em] text-fg-40 hover:text-accent-ink transition-colors"
                    >
                        ver o que o comerciante vê
                    </a>
                </div>
            </header>

            <ChangelogList
                entries={CHANGELOG}
                internal
                labels={{
                    highlight: "Destaque",
                    untitled: "Versão",
                    commit: (sha) => `último commit ${sha}`,
                }}
            />
        </div>
    );
}
