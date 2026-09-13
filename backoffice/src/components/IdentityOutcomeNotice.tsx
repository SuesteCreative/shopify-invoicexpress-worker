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
 * It stays until the account's OWNER dismisses it, and that dismissal is stored
 * on the account rather than in this browser (migration 0059) — otherwise the
 * next device would re-announce a change from three weeks ago. Anyone else who
 * sees it (an invited member, an operator impersonating) is told by the server
 * they may not store it, and the notice hides in their browser instead: their
 * click must not close it for the owner, who is the one it is for.
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

/**
 * Where a viewer who may not store the dismissal remembers it instead.
 *
 * localStorage, not sessionStorage: a session-scoped hide came back in every new
 * tab, which read as a close button that did nothing. Keyed by the decision
 * itself rather than by a date, so hiding one account's answer while
 * impersonating it never hides a different account's.
 */
const HIDDEN_KEY = "rioko.identity-notice-hidden";

const signature = (o: Outcome) =>
    `${o.field}|${o.outcome}|${o.decided_at ?? ""}|${o.decided_value ?? o.reason ?? ""}`;

function hiddenSignatures(): string[] {
    try {
        const v = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]");
        return Array.isArray(v) ? v.map(String) : [];
    } catch { return []; }
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
                const may = d.can_dismiss !== false;
                const hidden = may ? [] : hiddenSignatures();
                setCanDismiss(may);
                setUnread(((d.unread ?? []) as Outcome[]).filter(o => !hidden.includes(signature(o))));
            })
            .catch(() => { /* a notice is not worth a broken dashboard */ });
    }, []);

    if (unread.length === 0) return null;

    const dismiss = () => {
        const shown = unread;
        setUnread([]);
        if (!canDismiss) {
            // ponytail: per browser — the same operator on another device sees it
            // once more there. A per-viewer column when that ever matters.
            try {
                localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hiddenSignatures(), ...shown.map(signature)].slice(-50)));
            } catch { /* hidden until reload, then */ }
            return;
        }
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
                    {granted.map(o => {
                        // What the record NOW says. For a recorded decision that is
                        // the value written — which may be a corrected one, or
                        // nothing at all if it was cleared — never the value once
                        // asked for.
                        const now = o.decided_at ? (o.decided_value ?? "") : (o.requested ?? "");
                        return (
                            <p key={`ok-${o.field}`} className="text-sm font-medium text-fg">
                                {now
                                    ? t("noticeApplied", { field: label(o.field), value: now })
                                    : t("noticeCleared", { field: label(o.field) })}
                            </p>
                        );
                    })}
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
