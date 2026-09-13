"use client";

import { useTranslations } from "next-intl";

export type FilterKey = "all" | "exact" | "approved" | "heuristic" | "none" | "not_needed" | "pending" | "refunded" | "credit_missing";

/** Message key (under the `conciliacao` namespace) for each filter chip. */
export const FILTER_KEYS: Record<FilterKey, string> = {
    all: "filterAll",
    exact: "filterExact",
    approved: "filterApproved",
    heuristic: "filterHeuristic",
    none: "filterNone",
    not_needed: "filterNotNeeded",
    pending: "filterPending",
    refunded: "filterRefunded",
    credit_missing: "filterCreditMissing",
};

const COLORS: Record<FilterKey, string> = {
    all: "bg-surface-2 text-fg border-hairline",
    exact: "bg-accent-hot/10 text-accent-hot border-accent-hot/30",
    approved: "bg-accent-hot/10 text-accent-hot border-accent-hot/30",
    heuristic: "bg-accent/10 text-accent-ink border-accent/30",
    none: "bg-destructive/10 text-destructive border-destructive/30",
    not_needed: "bg-soon/10 text-soon border-soon/30",
    pending: "bg-veil-strong text-fg-60 border-hairline-strong",
    refunded: "bg-destructive/10 text-destructive border-destructive/30",
    credit_missing: "bg-soon/10 text-soon border-soon/30",
};

export function Filters({ current, setCurrent, counts }: {
    current: FilterKey;
    setCurrent: (k: FilterKey) => void;
    counts: Record<FilterKey, number>;
}) {
    const t = useTranslations("conciliacao");
    return (
        <div className="flex flex-wrap gap-2">
            {(Object.keys(FILTER_KEYS) as FilterKey[]).map(k => (
                <button key={k} onClick={() => setCurrent(k)}
                    className={`px-4 py-2 rounded-xl font-mono text-[10px] uppercase tracking-[0.18em] border transition-all ${current === k ? COLORS[k] : "bg-surface-2/40 text-fg-40 border-hairline hover:text-fg"}`}>
                    {t(FILTER_KEYS[k])} <span className="opacity-60 ml-1">({counts[k] ?? 0})</span>
                </button>
            ))}
        </div>
    );
}
