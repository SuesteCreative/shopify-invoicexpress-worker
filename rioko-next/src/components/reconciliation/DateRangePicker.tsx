"use client";

export function DateRangePicker({ from, to, setFrom, setTo }: {
    from: string; to: string; setFrom: (s: string) => void; setTo: (s: string) => void;
}) {
    return (
        <div className="flex gap-3">
            <label className="flex flex-col gap-1 text-[10px] font-black uppercase tracking-widest text-slate-500">
                De
                <input type="date" value={from} onChange={e => setFrom(e.target.value)}
                    className="bg-slate-900/50 border border-slate-800 rounded-xl px-3 py-2 text-sm font-medium text-white" />
            </label>
            <label className="flex flex-col gap-1 text-[10px] font-black uppercase tracking-widest text-slate-500">
                Até
                <input type="date" value={to} onChange={e => setTo(e.target.value)}
                    className="bg-slate-900/50 border border-slate-800 rounded-xl px-3 py-2 text-sm font-medium text-white" />
            </label>
        </div>
    );
}
