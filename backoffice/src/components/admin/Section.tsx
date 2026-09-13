"use client";

/**
 * The card every admin panel is made of.
 *
 * Lifted out of DevModePanel when the customer record started needing the same
 * shape: two copies of a card is how two admin surfaces end up looking like two
 * products. Presentation only — no data, no translations of its own.
 */
export function Section({ icon, title, desc, right, children }: {
    icon: React.ReactNode;
    title: string;
    desc?: string;
    /** Optional controls on the title row (a link out, a toggle). */
    right?: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <section className="glass rounded-[2rem] p-5 sm:p-8 border-hairline space-y-6">
            <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-xl bg-surface-2 border border-hairline flex items-center justify-center shrink-0">
                    {icon}
                </div>
                <div className="min-w-0">
                    <h2 className="text-lg font-black tracking-tight">{title}</h2>
                    {desc && <p className="text-fg-40 text-xs font-medium mt-1">{desc}</p>}
                </div>
                {right && <div className="ml-auto shrink-0">{right}</div>}
            </div>
            {children}
        </section>
    );
}
