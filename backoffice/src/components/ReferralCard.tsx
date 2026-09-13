"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Gift, Copy, Check, Loader2, AlertTriangle } from "lucide-react";

/**
 * The campaign, where a merchant already thinks about what they pay.
 *
 * It lives on the billing page rather than behind a menu entry of its own: two
 * free months are a billing fact, and a nav item for a campaign that ends in
 * October is a nav item somebody has to remember to remove.
 *
 * The link is the account's customer number plus a suffix, so an invited seat
 * and the owner see the same one — two colleagues must not be able to produce
 * two links for one company.
 */

interface Invite {
    label: string;
    state: "pending" | "subscribed" | "rewarded" | "void";
    claimed_at: string;
    reward_until: string | null;
}
interface Me {
    code: string | null;
    token: string | null;
    link: string | null;
    campaign_end: string;
    campaign_open: boolean;
    eligible: boolean;
    reward_months: number;
    max_rewards: number;
    rewarded: number;
    months_earned: number;
    invited: number;
    invites: Invite[];
}

const ptDate = (iso: string) => {
    const [y, m, d] = String(iso).slice(0, 10).split("-");
    return d && m && y ? `${d}/${m}/${y}` : String(iso).slice(0, 10);
};

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
    // Once the campaign is over the card goes, rather than advertising something
    // nobody can still claim.
    if (!me.campaign_open && me.rewarded === 0) return null;

    const stateLabel: Record<Invite["state"], string> = {
        pending: t("statePending"),
        subscribed: t("stateSubscribed"),
        rewarded: t("stateRewarded"),
        void: t("stateVoid"),
    };

    return (
        <div className="space-y-4">
            <section className="glass rounded-[2rem] border-hairline p-5 sm:p-7 space-y-5">
                <div className="flex items-start gap-4">
                    <span className="w-10 h-10 rounded-2xl bg-accent/15 ring-1 ring-accent/30 flex items-center justify-center shrink-0">
                        <Gift className="w-5 h-5 text-accent-ink" />
                    </span>
                    <div className="space-y-1">
                        <h3 className="text-lg font-medium tracking-tight text-fg">{t("cardTitle")}</h3>
                        <p className="text-sm text-fg-60 leading-relaxed">{t("cardSubtitle")}</p>
                    </div>
                </div>

                {!me.eligible && (
                    <div className="flex items-start gap-3 px-4 py-3 rounded-2xl border border-soon/25 bg-soon/6 text-sm text-fg-60">
                        <AlertTriangle className="w-4 h-4 text-soon shrink-0 mt-0.5" />
                        <span>{t("needSubscription")}</span>
                    </div>
                )}

                {me.link && me.eligible && (
                    <div className="flex flex-col sm:flex-row gap-2">
                        <input
                            readOnly
                            value={me.link}
                            onFocus={(e) => e.currentTarget.select()}
                            className="flex-1 bg-surface-2/50 border border-hairline rounded-2xl px-5 py-3 font-mono text-[12px] text-fg focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all"
                        />
                        <button
                            onClick={copy}
                            className="px-5 py-3 rounded-2xl bg-accent/15 border border-accent/30 text-accent-ink font-mono text-[10px] uppercase tracking-[0.18em] hover:bg-accent/25 transition-all flex items-center justify-center gap-2"
                        >
                            {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                            {copied ? t("copied") : t("copy")}
                        </button>
                    </div>
                )}

                <div className="grid grid-cols-3 gap-3">
                    <Stat label={t("statInvited")} value={String(me.invited)} />
                    <Stat label={t("statRewarded")} value={`${me.rewarded}/${me.max_rewards}`} />
                    <Stat label={t("statMonths")} value={String(me.months_earned)} />
                </div>

                <p className="text-[11px] text-fg-40 leading-snug border-t border-hairline pt-4">
                    {t("cardTerms", { end: ptDate(me.campaign_end), max: me.max_rewards, months: me.max_rewards * me.reward_months })}{" "}
                    <Link href="/campanha-convites" className="text-accent-ink hover:underline">
                        {t("termsLink")}
                    </Link>
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
                                    {i.reward_until ? ` · ${ptDate(i.reward_until)}` : ""}
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
