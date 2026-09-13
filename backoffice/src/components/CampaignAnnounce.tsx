"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useTranslations } from "next-intl";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { campaignOpen } from "@/lib/referral";

/**
 * The one announcement, on the way in.
 *
 * Deliberately not a page and not a nav entry: the campaign ends on a date, and
 * a menu item for something that expires is a menu item somebody has to remember
 * to remove. After 31 October this renders nothing, everywhere, with no deploy —
 * it reads the same constant the server uses to refuse a claim.
 *
 * It reappears every session until dismissed. The flag is per user in
 * localStorage, the convention IntegrationSetupModal and the consent banner
 * already use, which makes it per BROWSER: a merchant on a second device sees it
 * once more. For an announcement with an expiry date that beats a column and a
 * route.
 *
 * Under impersonation `useAuth()` returns the admin's id, so an admin dismisses
 * it once for themselves and never meets it again on a client's dashboard.
 */

const KEY_PREFIX = "rioko_campaign_dismissed:";
const BANNER = "/images/campanha-convites.png";

/**
 * The artwork is 1920×1080 and carries its own headline, its own button and, at
 * the bottom, a URL that is no longer where the link lives.
 *
 * So the bottom strip is cropped away rather than covered — covering would mean
 * matching that cream by eye and being wrong on one screen out of ten — and the
 * real link goes underneath in HTML, where it is translatable, focusable and
 * right about where it points. 999 of 1080 rows keeps everything down to the
 * button and drops the line beneath it.
 */
const CROP = { width: 1920, height: 999 };

/** Where the drawn button sits, measured off the artwork, in percentages of the
 *  CROPPED box. A little generous on every side: an invisible hit area that is
 *  slightly larger than the thing it sits on is forgiving, one that is smaller
 *  reads as broken. */
const CTA_BOX = { left: "5.1%", top: "78.4%", width: "15.4%", height: "7.4%" };

export default function CampaignAnnounce() {
    const t = useTranslations("campaignAnnounce");
    const { isLoaded, isSignedIn, userId } = useAuth();
    const [open, setOpen] = useState(false);
    const [hasImage, setHasImage] = useState(true);
    const [dontShowAgain, setDontShowAgain] = useState(false);

    const remember = useCallback(() => {
        try {
            if (userId) localStorage.setItem(KEY_PREFIX + userId, "1");
        } catch { /* private mode: it comes back next session, which is survivable */ }
    }, [userId]);

    /**
     * Closing and silencing are different acts, and the tick is what separates
     * them. Without it this comes back next session, which is what "reaparece
     * até ser dispensado" means; with it, never again.
     */
    const close = useCallback(() => {
        setOpen(false);
        if (dontShowAgain) remember();
    }, [dontShowAgain, remember]);

    /** Following the announcement is dismissing it: bringing it back to somebody
     *  who already acted on it is nagging, tick or no tick. */
    const follow = useCallback(() => {
        setOpen(false);
        remember();
    }, [remember]);

    useEffect(() => {
        if (!isLoaded || !isSignedIn || !userId) return;
        if (!campaignOpen()) return;
        let dismissed = false;
        try { dismissed = localStorage.getItem(KEY_PREFIX + userId) === "1"; } catch { /* ignore */ }
        if (dismissed) return;
        // Late enough not to fight the page painting in, early enough to be the
        // first thing read. Same shape as IntegrationSetupModal.
        const timer = setTimeout(() => setOpen(true), 900);
        return () => clearTimeout(timer);
    }, [isLoaded, isSignedIn, userId]);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open, close]);

    return (
        <AnimatePresence>
            {open && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    onClick={close}
                    role="dialog"
                    aria-modal="true"
                    aria-label={t("title")}
                    className="fixed inset-0 z-[90] flex items-center justify-center p-4 bg-scrim backdrop-blur-sm"
                >
                    <motion.div
                        initial={{ opacity: 0, y: 12, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 8, scale: 0.99 }}
                        onClick={(e) => e.stopPropagation()}
                        className="glass rounded-[2rem] border-hairline w-full max-w-3xl overflow-hidden relative"
                    >
                        <button
                            onClick={close}
                            aria-label={t("dismiss")}
                            className="absolute top-4 right-4 z-20 w-8 h-8 rounded-full grid place-items-center bg-surface/70 border border-hairline text-fg-60 hover:text-fg transition-colors"
                        >
                            <X className="w-4 h-4" />
                        </button>

                        {hasImage ? (
                            <div
                                className="relative w-full overflow-hidden"
                                style={{ aspectRatio: `${CROP.width} / ${CROP.height}` }}
                            >
                                <img
                                    src={BANNER}
                                    alt={t("title")}
                                    onError={() => setHasImage(false)}
                                    className="absolute inset-x-0 top-0 w-full"
                                />
                                {/* The drawn button, made real. Transparent by
                                    design — the artwork already shows the button;
                                    this only has to be clickable and reachable
                                    from a keyboard. */}
                                <Link
                                    href="/faturacao"
                                    onClick={follow}
                                    aria-label={t("cta")}
                                    className="absolute rounded-full ring-offset-2 ring-offset-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                                    style={CTA_BOX}
                                />
                            </div>
                        ) : (
                            // An announcement with a broken image is worse than
                            // one without, so the words carry it alone.
                            <div className="px-6 pt-8 sm:px-8">
                                <h2 className="text-2xl font-medium tracking-tight text-fg">{t("title")}</h2>
                            </div>
                        )}

                        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 sm:px-8 py-4 border-t border-hairline">
                            {!hasImage && (
                                <Link
                                    href="/faturacao"
                                    onClick={follow}
                                    className="px-5 py-3 rounded-2xl bg-accent text-surface font-mono text-[10px] uppercase tracking-[0.18em] font-bold hover:bg-accent-hot transition-all"
                                >
                                    {t("cta")}
                                </Link>
                            )}
                            {/* What the artwork's bottom line used to say, now
                                pointing where it should. */}
                            <Link
                                href="/campanha-convites"
                                onClick={follow}
                                className="font-mono text-[10px] uppercase tracking-[0.18em] text-fg-60 hover:text-accent-ink transition-colors"
                            >
                                {t("terms")}
                            </Link>
                            <label className="ml-auto flex items-center gap-2 text-[11px] text-fg-40 cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    checked={dontShowAgain}
                                    onChange={(e) => setDontShowAgain(e.target.checked)}
                                    className="w-3.5 h-3.5 rounded border-hairline accent-accent cursor-pointer"
                                />
                                {t("dontShowAgain")}
                            </label>
                            <button
                                onClick={close}
                                className="text-[11px] text-fg-40 hover:text-fg-60 transition-colors"
                            >
                                {t("dismiss")}
                            </button>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}
