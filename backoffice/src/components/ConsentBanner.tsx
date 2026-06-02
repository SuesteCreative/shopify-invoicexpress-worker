"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations, useLocale } from "next-intl";

const STORAGE_KEY = "rioko-consent";
// Bump when the consent categories/meaning change → re-prompts everyone.
const CONSENT_VERSION = 1;
// Re-ask after 180 days (CNIL guidance).
const MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
// Custom event any UI (e.g. footer "Cookie settings") can dispatch to reopen.
const OPEN_EVENT = "rioko:open-consent";

type ConsentChoice = "granted" | "denied";

type StoredConsent = {
    choice: ConsentChoice;
    ts: number;
    v: number;
};

/**
 * Push a Consent Mode v2 update to GA. Analytics-only: ad_* signals are never
 * granted here — they stay at the layout's `default: denied`, since the app runs
 * no ad tech and the banner copy only asks about analytics.
 */
function applyConsent(choice: ConsentChoice) {
    const gtag = (window as unknown as { gtag?: (...args: unknown[]) => void }).gtag;
    gtag?.("consent", "update", {
        analytics_storage: choice,
    });
}

function readStored(): StoredConsent | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<StoredConsent>;
        if (
            (parsed.choice !== "granted" && parsed.choice !== "denied") ||
            typeof parsed.ts !== "number" ||
            parsed.v !== CONSENT_VERSION ||
            Date.now() - parsed.ts > MAX_AGE_MS
        ) {
            return null;
        }
        return parsed as StoredConsent;
    } catch {
        return null;
    }
}

export default function ConsentBanner() {
    const t = useTranslations("consent");
    const locale = useLocale();
    const [visible, setVisible] = useState(false);
    const rejectRef = useRef<HTMLButtonElement | null>(null);

    useEffect(() => {
        const stored = readStored();
        if (stored) {
            // Returning visitor with a still-valid choice — replay it into GA.
            applyConsent(stored.choice);
        } else {
            setVisible(true);
        }

        // Let other UI reopen the banner (consent withdrawal, GDPR Art 7(3)).
        const reopen = () => setVisible(true);
        window.addEventListener(OPEN_EVENT, reopen);
        return () => window.removeEventListener(OPEN_EVENT, reopen);
    }, []);

    // Move focus to the first action when the banner appears (a11y).
    useEffect(() => {
        if (visible) rejectRef.current?.focus();
    }, [visible]);

    const choose = (choice: ConsentChoice) => {
        const record: StoredConsent = { choice, ts: Date.now(), v: CONSENT_VERSION };
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
        } catch {
            // Storage blocked — still honour the choice for this session.
        }
        applyConsent(choice);
        setVisible(false);
    };

    if (!visible) return null;

    return (
        <div
            role="dialog"
            aria-label={t("title")}
            aria-describedby="consent-desc"
            className="fixed inset-x-0 bottom-0 z-[100] flex justify-center p-4 sm:p-6 pointer-events-none"
        >
            <div className="pointer-events-auto w-full max-w-2xl rounded-2xl border border-hairline bg-surface/95 backdrop-blur-xl p-5 shadow-2xl flex flex-col sm:flex-row sm:items-center gap-4">
                <p id="consent-desc" className="flex-1 text-sm text-fg-60 leading-relaxed">
                    {t("message")}{" "}
                    <a
                        href={`/${locale}/privacy`}
                        className="text-[#028dc4] underline underline-offset-2 hover:text-[#3aa9d8] transition-colors"
                    >
                        {t("learnMore")}
                    </a>
                </p>
                <div className="flex gap-2 shrink-0">
                    <button
                        ref={rejectRef}
                        onClick={() => choose("denied")}
                        className="px-4 py-2.5 rounded-xl text-[11px] font-black uppercase tracking-widest bg-surface-2 text-fg-60 ring-1 ring-hairline hover:bg-surface-2/70 transition-colors"
                    >
                        {t("reject")}
                    </button>
                    <button
                        onClick={() => choose("granted")}
                        className="px-4 py-2.5 rounded-xl text-[11px] font-black uppercase tracking-widest bg-[#028dc4] text-white hover:bg-[#028dc4]/85 transition-colors"
                    >
                        {t("accept")}
                    </button>
                </div>
            </div>
        </div>
    );
}
