"use client";

export type FilterKey = "all" | "exact" | "approved" | "heuristic" | "none" | "not_needed" | "pending" | "refunded" | "credit_missing";

const LABELS: Record<FilterKey, string> = {
    all: "Todos",
    exact: "Match exato",
    approved: "Aprovados",
    heuristic: "Heurístico",
    none: "Sem fatura",
    not_needed: "Não necessárias",
    pending: "Aguarda pagamento",
    refunded: "Reembolsos/cancel.",
    credit_missing: "NC em falta",
};

const COLORS: Record<FilterKey, string> = {
    all: "bg-surface-2 text-fg border-hairline",
    exact: "bg-[rgba(94,234,212,0.10)] text-accent-hot border-[rgba(94,234,212,0.30)]",
    approved: "bg-[rgba(94,234,212,0.10)] text-accent-hot border-[rgba(94,234,212,0.30)]",
    heuristic: "bg-[rgba(2,141,196,0.10)] text-accent border-[rgba(2,141,196,0.30)]",
    none: "bg-[rgba(244,63,94,0.10)] text-destructive border-[rgba(244,63,94,0.30)]",
    not_needed: "bg-[rgba(245,158,11,0.10)] text-soon border-[rgba(245,158,11,0.30)]",
    pending: "bg-[rgba(148,163,184,0.10)] text-fg-60 border-[rgba(148,163,184,0.30)]",
    refunded: "bg-[rgba(244,63,94,0.10)] text-destructive border-[rgba(244,63,94,0.30)]",
    credit_missing: "bg-[rgba(245,158,11,0.10)] text-soon border-[rgba(245,158,11,0.30)]",
};

export function Filters({ current, setCurrent, counts }: {
    current: FilterKey;
    setCurrent: (k: FilterKey) => void;
    counts: Record<FilterKey, number>;
}) {
    return (
        <div className="flex flex-wrap gap-2">
            {(Object.keys(LABELS) as FilterKey[]).map(k => (
                <button key={k} onClick={() => setCurrent(k)}
                    className={`px-4 py-2 rounded-xl font-mono text-[10px] uppercase tracking-[0.18em] border transition-all ${current === k ? COLORS[k] : "bg-surface-2/40 text-fg-40 border-hairline hover:text-fg"}`}>
                    {LABELS[k]} <span className="opacity-60 ml-1">({counts[k] ?? 0})</span>
                </button>
            ))}
        </div>
    );
}
