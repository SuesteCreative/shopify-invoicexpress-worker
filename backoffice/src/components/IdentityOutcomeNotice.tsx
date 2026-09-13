"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Check, X, AlertCircle } from "lucide-react";

/**
 * "We answered what you asked" — rendered once by the dashboard layout so it
 * reaches the merchant wherever they land.
 *
 * A merchant can ask us to correct the two fields they cannot edit, their VAT
 * number and their legal name. Until this existed the answer travelled one way:
 * the operator granted or refused it and the merchant found out by noticing the
 * value had changed, or never.
 *
 * It stays until dismissed, and the dismissal is stored on the account rather
 * than in this browser (migration 0059) — otherwise the next device would
 * re-announce a change from three weeks ago. The one case it cannot store is a
 * read-only member, who may not write to the account at all; there the server
 * says so and the notice is hidden for the session instead of a button that
 * silently does nothing.
 *
 * Same shape and the same home as AccountSuspendedNotice: a notice nobody can
 * miss by adding a page.
 */

interface Outcome {
    field: string;
    requested: string | null;
    /** What was written, which is not always what was asked. */
    decided_value: string | null;
    outcome: "applied" | "rejected" | "pending";
    decided_at: string | null;
    reason: string | null;
}

export default function IdentityOutcomeNotice() {
    const t = useTranslations("conta");
    const [unread, setUnread] = useState<Outcome[]>([]);
    const [canDismiss, setCanDismiss] = useState(true);

    useEffect(() => {
        fetch("/api/user/identity-request")
            .then(r => (r.ok ? r.json() : null))
            .then((d: any) => {
                if (!d) return;
                setUnread(d.unread ?? []);
                setCanDismiss(d.can_dismiss !== false);
            })
            .catch(() => { /* a notice is not worth a broken dashboard */ });
    }, []);

    if (unread.length === 0) return null;

    const dismiss = () => {
        setUnread([]);
        if (!canDismiss) return;
        fetch("/api/user/identity-request", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ dismiss: true }),
        }).catch(() => { /* it will be offered again, which is the safe way to fail */ });
    };

    const label = (f: string) => (f === "nif" ? t("nif") : t("companyName"));
    const granted = unread.filter(o => o.outcome === "applied");
    const refused = unread.filter(o => o.outcome === "rejected");

    return (
        <div className="mb-8 glass rounded-2xl border border-hairline p-4 sm:p-5 space-y-3">
            <div className="flex items-start gap-3">
                <div className="shrink-0 mt-0.5">
                    {refused.length > 0
                        ? <AlertCircle className="w-4 h-4 text-soon" />
                        : <Check className="w-4 h-4 text-accent-ink" />}
                </div>
                <div className="space-y-2 min-w-0 flex-1">
                    {granted.map(o => (
                        <p key={`ok-${o.field}`} className="text-sm font-medium text-fg">
                            {/* What the record NOW says, not what was once
                                asked: an operator may have corrected a typo in
                                the number the client sent. */}
                            {t("noticeApplied", { field: label(o.field), value: o.decided_value ?? o.requested ?? "" })}
                        </p>
                    ))}
                    {refused.map(o => (
                        <div key={`no-${o.field}`} className="space-y-1">
                            <p className="text-sm font-medium text-fg">
                                {t("noticeRejected", { field: label(o.field) })}
                            </p>
                            {o.reason
                                ? <p className="text-xs text-fg-40 italic">“{o.reason}”</p>
                                : <p className="text-xs text-fg-40">{t("noticeRejectedNoReason")}</p>}
                        </div>
                    ))}
                    <Link href="/conta" className="inline-block text-[10px] font-black uppercase tracking-widest text-accent-ink hover:underline">
                        {t("noticeLink")}
                    </Link>
                </div>
                <button type="button" onClick={dismiss} aria-label={t("noticeDismiss")}
                    className="shrink-0 p-1.5 rounded-lg text-fg-40 hover:text-fg hover:bg-fg/5 transition-colors">
                    <X className="w-4 h-4" />
                </button>
            </div>
        </div>
    );
}
