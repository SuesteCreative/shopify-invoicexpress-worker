"use client";

import { useTranslations } from "next-intl";

export function DateRangePicker({ from, to, setFrom, setTo }: {
    from: string; to: string; setFrom: (s: string) => void; setTo: (s: string) => void;
}) {
    const t = useTranslations("conciliacao");
    return (
        <div className="flex gap-3">
            <label className="flex flex-col gap-1 font-mono text-[10px] uppercase tracking-[0.22em] text-fg-40">
                {t("dateFrom")}
                <input type="date" value={from} onChange={e => setFrom(e.target.value)}
                    className="bg-surface-2 border border-hairline rounded-xl px-3 py-2 text-sm font-medium text-fg" />
            </label>
            <label className="flex flex-col gap-1 font-mono text-[10px] uppercase tracking-[0.22em] text-fg-40">
                {t("dateTo")}
                <input type="date" value={to} onChange={e => setTo(e.target.value)}
                    className="bg-surface-2 border border-hairline rounded-xl px-3 py-2 text-sm font-medium text-fg" />
            </label>
        </div>
    );
}
