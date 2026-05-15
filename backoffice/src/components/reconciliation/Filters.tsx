"use client";

export type FilterKey = "all" | "exact" | "approved" | "heuristic" | "none" | "not_needed";

const LABELS: Record<FilterKey, string> = {
    all: "Todos",
    exact: "Match exato",
    approved: "Aprovados",
    heuristic: "Heurístico",
    none: "Sem fatura",
    not_needed: "Não necessárias",
};

const COLORS: Record<FilterKey, string> = {
    all: "bg-slate-800 text-slate-200 border-slate-700",
    exact: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
    approved: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
    heuristic: "bg-amber-500/10 text-amber-300 border-amber-500/30",
    none: "bg-red-500/10 text-red-300 border-red-500/30",
    not_needed: "bg-slate-500/10 text-slate-300 border-slate-500/30",
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
                    className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest border transition-all ${current === k ? COLORS[k] : "bg-slate-900/40 text-slate-500 border-slate-800 hover:text-slate-300"}`}>
                    {LABELS[k]} <span className="opacity-60 ml-1">({counts[k] ?? 0})</span>
                </button>
            ))}
        </div>
    );
}
