import type { ChangelogBlock, ChangelogEntry } from "@/lib/changelog.generated";

/**
 * The release list, rendered twice from one source: the merchant page shows
 * `CHANGELOG_PUBLIC` with each entry's merchant lines, the admin page shows
 * every entry in full. The difference is the data handed in, not two designs.
 *
 * Labels come in as props rather than from `useTranslations`: the merchant page
 * resolves them per locale, and the admin surface is Portuguese by design.
 */

type Labels = { highlight: string; untitled: string; commit: (sha: string) => string };

/** Inline markup, the only two the changelog uses: **bold** and `code`. */
function Rich({ text }: { text: string }) {
    const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
    return (
        <>
            {parts.map((part, i) => {
                if (part.startsWith("**") && part.endsWith("**")) {
                    return (
                        <strong key={i} className="font-semibold text-fg">
                            {part.slice(2, -2)}
                        </strong>
                    );
                }
                if (part.startsWith("`") && part.endsWith("`")) {
                    return (
                        <code
                            key={i}
                            className="font-mono text-[0.85em] px-1 py-0.5 rounded bg-veil text-fg"
                        >
                            {part.slice(1, -1)}
                        </code>
                    );
                }
                return <span key={i}>{part}</span>;
            })}
        </>
    );
}

function Body({ blocks }: { blocks: ChangelogBlock[] }) {
    return (
        <div className="space-y-3">
            {blocks.map((b, i) => {
                if (b.t === "h") {
                    return (
                        <h3
                            key={i}
                            className="pt-3 font-mono text-[10px] uppercase tracking-[0.18em] text-fg-40"
                        >
                            <Rich text={b.text} />
                        </h3>
                    );
                }
                if (b.t === "code") {
                    return (
                        <pre
                            key={i}
                            className="overflow-x-auto rounded-lg border border-hairline bg-sunken p-3 font-mono text-[11px] leading-relaxed text-fg-60"
                        >
                            {b.text}
                        </pre>
                    );
                }
                if (b.t === "li") {
                    return (
                        <div key={i} className="flex gap-3 text-sm text-fg-60 leading-relaxed">
                            <span aria-hidden className="text-accent-ink select-none">
                                ·
                            </span>
                            <p className="flex-1">
                                <Rich text={b.text} />
                            </p>
                        </div>
                    );
                }
                return (
                    <p key={i} className="text-sm text-fg-60 leading-relaxed">
                        <Rich text={b.text} />
                    </p>
                );
            })}
        </div>
    );
}

export function ChangelogList({
    entries,
    internal = false,
    labels,
}: {
    entries: ChangelogEntry[];
    /** Full entry and release marker, instead of the merchant lines alone. */
    internal?: boolean;
    labels: Labels;
}) {
    return (
        <ol className="space-y-4">
            {entries.map((entry, i) => (
                <li key={`${entry.version}-${i}`}>
                    <details
                        open={i === 0}
                        className="rounded-xl border border-hairline bg-veil/40 px-4 py-3 md:px-5 md:py-4"
                    >
                        <summary className="cursor-pointer list-none flex flex-wrap items-baseline gap-x-3 gap-y-1">
                            <span className="font-mono text-xs text-accent-ink tracking-[0.12em]">
                                v{entry.version}
                            </span>
                            <span className="flex-1 min-w-[12rem] text-sm md:text-base text-fg">
                                {entry.emoji ? `${entry.emoji} ` : ""}
                                {entry.title || labels.untitled}
                            </span>
                            {entry.highlight ? (
                                <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-accent-hot">
                                    {labels.highlight}
                                </span>
                            ) : null}
                            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-40">
                                {entry.date}
                            </span>
                        </summary>

                        <div className="mt-4 pt-4 border-t border-hairline">
                            <Body blocks={internal ? entry.body : entry.publicBody} />
                            {internal && entry.commit ? (
                                <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.14em] text-fg-40">
                                    {labels.commit(entry.commit)}
                                </p>
                            ) : null}
                        </div>
                    </details>
                </li>
            ))}
        </ol>
    );
}
