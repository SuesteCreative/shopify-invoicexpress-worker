"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Gift, Copy, Check, Loader2 } from "lucide-react";

/**
 * The merchant's own referral link.
 *
 * One link, theirs, minted on the first view. It is deliberately not put inside
 * the newsletter that announces the campaign: a personal link in the body of an
 * email gets forwarded, and a forwarded personal link credits whoever it was
 * forwarded from, which is the wrong person twice over.
 */

interface Invite {
    label: string;
    state: "pending" | "paid" | "credited";
    credit_cents: number | null;
    claimed_at: string;
}
interface Me {
    code: string | null;
    link: string | null;
    campaign_end: string;
    invited: number;
    paid: number;
    credited_cents: number;
    invites: Invite[];
}

const euro = (cents: number) =>
    new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(cents / 100);

export function ReferralCard() {
    const t = useTranslations("referral");
    const [me, setMe] = useState<Me | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        fetch("/api/referral/me")
            .then(async (r) => {
                const body = await r.json() as any;
                if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
                setMe(body as Me);
            })
            .catch((e) => setError(String(e.message ?? e)));
    }, []);

    const copy = async () => {
        if (!me?.link) return;
        try {
            await navigator.clipboard.writeText(me.link);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch { /* a browser that refuses the clipboard still shows the link */ }
    };

    if (error) {
        return (
            <div className="px-4 py-3 rounded-xl bg-destructive/5 border border-destructive/20 text-destructive text-xs font-medium">
                {error}
            </div>
        );
    }
    if (!me) {
        return (
            <div className="flex items-center gap-2 text-sm text-fg-40">
                <Loader2 className="w-4 h-4 animate-spin" /> {t("loading")}
            </div>
        );
    }

    const stateLabel: Record<Invite["state"], string> = {
        pending: t("statePending"),
        paid: t("statePaid"),
        credited: t("stateCredited"),
    };

    return (
        <div className="space-y-6">
            <section className="glass rounded-[2rem] border-hairline p-5 sm:p-7 space-y-5">
                <div className="flex items-start gap-3">
                    <span className="w-10 h-10 rounded-2xl bg-accent/18 border border-accent/45 flex items-center justify-center shrink-0">
                        <Gift className="w-5 h-5 text-accent-ink" />
                    </span>
                    <div className="space-y-1">
                        <h2 className="text-lg font-medium tracking-tight text-fg">{t("cardTitle")}</h2>
                        <p className="text-sm text-fg-60 leading-relaxed">{t("cardSubtitle")}</p>
                    </div>
                </div>

                <div className="flex flex-col sm:flex-row gap-2">
                    <input
                        readOnly
                        value={me.link ?? ""}
                        onFocus={(e) => e.currentTarget.select()}
                        className="flex-1 bg-surface-2/50 border border-hairline rounded-xl px-3 py-2 font-mono text-[12px] text-fg focus:outline-none focus:ring-2 focus:ring-accent/20"
                    />
                    <button
                        onClick={copy}
                        className="px-4 py-2 rounded-xl text-sm font-medium bg-fg text-surface hover:bg-accent hover:text-on-accent transition-all flex items-center justify-center gap-2"
                    >
                        {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                        {copied ? t("copied") : t("copy")}
                    </button>
                </div>

                <div className="grid grid-cols-3 gap-3">
                    <Stat label={t("statInvited")} value={String(me.invited)} />
                    <Stat label={t("statPaid")} value={String(me.paid)} />
                    <Stat label={t("statEarned")} value={euro(me.credited_cents)} />
                </div>

                <p className="text-[11px] text-fg-40 leading-snug border-t border-hairline pt-4">
                    {t("cardTerms", { end: me.campaign_end })}
                </p>
            </section>

            {me.invites.length > 0 && (
                <section className="glass rounded-[2rem] border-hairline p-5 sm:p-7 space-y-3">
                    <h3 className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">
                        {t("listTitle")}
                    </h3>
                    <div className="space-y-1">
                        {me.invites.map((i, idx) => (
                            <div key={idx} className="flex items-baseline justify-between gap-3">
                                <span className="text-sm text-fg truncate">{i.label}</span>
                                <span className="font-mono text-[11px] text-fg-40 shrink-0">
                                    {stateLabel[i.state]}
                                    {i.credit_cents ? ` · ${euro(i.credit_cents)}` : ""}
                                </span>
                            </div>
                        ))}
                    </div>
                </section>
            )}
        </div>
    );
}

function Stat({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-2xl bg-surface-2 border border-hairline p-3">
            <p className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.18em]">{label}</p>
            <p className="mt-1 text-xl font-medium tracking-tight text-fg">{value}</p>
        </div>
    );
}
