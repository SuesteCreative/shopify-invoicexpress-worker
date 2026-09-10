"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { EmbeddedCheckout, EmbeddedCheckoutProvider } from "@stripe/react-stripe-js";
import { AlertTriangle, Check, Loader2, ShieldCheck } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

/**
 * The payment step of an onboarding page: the card form on the page itself.
 *
 * It is the same Checkout Session the dashboard uses — same price, same 23% VAT,
 * same promotion codes, same NIF field — asked for with `ui_mode: "embedded"`, so
 * Stripe hands back a client secret instead of a URL and the form mounts here in
 * an iframe. The merchant never leaves the flow they were sent a link to.
 *
 * Written for onboarding pages in general, not for one of them: everything that
 * differs between products arrives as a prop.
 */

type Plan = "monthly" | "annual";

type Props = {
    /** Which product to bill; the checkout route maps it to a price. */
    source: string;
    /** Which connection the subscription pays for (migration 0044). */
    connectionKey: string;
    /** Where Stripe returns to, through the fixed map in `@/lib/oauth-return`. */
    returnSlug: string;
    /** Called once the subscription is actually live, so the page can move on. */
    onSubscribed?: () => void;
};

type SessionResponse = {
    client_secret?: string;
    publishable_key?: string | null;
    url?: string;
    error?: string;
};

export default function OnboardingSubscribe({ source, connectionKey, returnSlug, onSubscribed }: Props) {
    const t = useTranslations("onboardingSubscribe");
    const tCard = useTranslations("subscriptionCard");
    const locale = useLocale();
    const params = useSearchParams();

    const [plan, setPlan] = useState<Plan>("annual");
    const [clientSecret, setClientSecret] = useState<string | null>(null);
    const [publishableKey, setPublishableKey] = useState<string | null>(null);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(true);
    const [openingHosted, setOpeningHosted] = useState(false);

    // Set when Stripe brings the merchant back to this page.
    const returnedSessionId = params.get("stripe") === "return" ? params.get("session_id") : null;
    const [returnState, setReturnState] = useState<"checking" | "confirming" | "done" | "failed" | null>(
        returnedSessionId ? "checking" : null,
    );

    const createSession = useCallback(async (which: Plan, uiMode: "embedded" | "hosted"): Promise<SessionResponse> => {
        const res = await fetch("/api/billing/checkout", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                plan: which,
                source,
                connection_key: connectionKey,
                locale,
                ...(uiMode === "embedded" ? { ui_mode: "embedded", return_slug: returnSlug } : {}),
            }),
        });
        const json = (await res.json().catch(() => ({}))) as SessionResponse;
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        return json;
    }, [source, connectionKey, returnSlug, locale]);

    // A session per plan: changing plan means a new one, and the form remounts.
    useEffect(() => {
        if (returnedSessionId) { setLoading(false); return; }
        let cancelled = false;
        setLoading(true);
        setError("");
        setClientSecret(null);
        createSession(plan, "embedded")
            .then(json => {
                if (cancelled) return;
                if (!json.client_secret || !json.publishable_key) {
                    throw new Error(json.error ?? "missing_client_secret");
                }
                setClientSecret(json.client_secret);
                setPublishableKey(json.publishable_key);
            })
            .catch(e => { if (!cancelled) setError(e?.message ?? "Unknown error"); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [plan, createSession, returnedSessionId]);

    // Stripe.js is loaded once, with the key the server just handed us.
    const stripePromise = useMemo<Promise<Stripe | null> | null>(
        () => (publishableKey ? loadStripe(publishableKey) : null),
        [publishableKey],
    );

    // Whether the form actually appeared.
    //
    // Everything can succeed — a session created, a client secret returned,
    // Stripe.js loaded — and the frame still come up empty: a blocked script, or
    // a session made for a different generation of the mount API. It stayed
    // silent, and a blank rectangle is the one failure a merchant cannot report
    // usefully. So the container is checked for the iframe Stripe injects, and
    // if it is not there the hosted page is offered instead.
    const frameRef = useRef<HTMLDivElement | null>(null);
    const [frameEmpty, setFrameEmpty] = useState(false);
    useEffect(() => {
        if (!clientSecret || !stripePromise) return;
        setFrameEmpty(false);
        const timer = setTimeout(() => {
            setFrameEmpty(!frameRef.current?.querySelector("iframe"));
        }, 8000);
        return () => clearTimeout(timer);
    }, [clientSecret, stripePromise]);

    // Back from Stripe: say what happened, then wait for the webhook to write the
    // row. Without this the step would read "no subscription" for the few seconds
    // between the card being charged and the event landing.
    const pollsRef = useRef(0);
    useEffect(() => {
        if (!returnedSessionId) return;
        let stopped = false;

        const settle = async () => {
            try {
                const res = await fetch(`/api/billing/session-status?session_id=${encodeURIComponent(returnedSessionId)}`);
                const json: any = await res.json().catch(() => ({}));
                if (stopped) return;
                if (json.status !== "complete") { setReturnState("failed"); return; }
                setReturnState("confirming");

                const check = async () => {
                    if (stopped) return;
                    const sub: any = await fetch(
                        `/api/billing/subscription?connection_key=${encodeURIComponent(connectionKey)}`,
                    ).then(r => r.json()).catch(() => ({}));
                    if (stopped) return;
                    if (sub?.ui_state === "active" || sub?.ui_state === "exempt") {
                        setReturnState("done");
                        onSubscribed?.();
                        return;
                    }
                    // The webhook is usually there within a second or two; give it
                    // ten before saying anything, and never spin forever.
                    if (pollsRef.current++ < 5) setTimeout(check, 2000);
                    else setReturnState("done");
                };
                check();
            } catch {
                if (!stopped) setReturnState("failed");
            }
        };

        settle();
        return () => { stopped = true; };
    }, [returnedSessionId, connectionKey, onSubscribed]);

    const openHosted = async () => {
        setOpeningHosted(true);
        try {
            const json = await createSession(plan, "hosted");
            if (json.url) window.location.href = json.url;
            else setError(json.error ?? "missing_url");
        } catch (e: any) {
            setError(e?.message ?? "Unknown error");
        } finally {
            setOpeningHosted(false);
        }
    };

    if (returnState) {
        const tone = returnState === "failed" ? "bad" : returnState === "done" ? "good" : "info";
        const Icon = returnState === "failed" ? AlertTriangle : returnState === "done" ? Check : Loader2;
        return (
            <div className={cn(
                "flex items-start gap-3.5 rounded-2xl border px-5 py-4 text-[12px] leading-relaxed",
                tone === "bad" ? "border-destructive/30 bg-destructive/8 text-destructive"
                    : tone === "good" ? "border-accent-hot/25 bg-accent-hot/8 text-fg-60"
                        : "border-accent/20 bg-accent/5 text-fg-60",
            )}>
                <Icon className={cn(
                    "w-4 h-4 shrink-0 mt-0.5",
                    tone === "bad" ? "text-destructive" : tone === "good" ? "text-accent-hot" : "text-accent-ink animate-spin",
                )} />
                <div className="min-w-0 space-y-1">
                    <p className="font-medium text-fg">
                        {returnState === "failed" ? t("failedTitle") : returnState === "done" ? t("doneTitle") : t("confirmingTitle")}
                    </p>
                    <p>{returnState === "failed" ? t("failedBody") : returnState === "done" ? t("doneBody") : t("confirmingBody")}</p>
                    {returnState === "failed" && (
                        <button
                            onClick={() => { setReturnState(null); pollsRef.current = 0; }}
                            className="mt-2 rounded-xl border border-hairline px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] transition-colors hover:border-rule"
                        >
                            {t("retry")}
                        </button>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {(["monthly", "annual"] as const).map(option => {
                    const selected = plan === option;
                    return (
                        <button
                            key={option}
                            type="button"
                            onClick={() => setPlan(option)}
                            className={cn(
                                "relative rounded-2xl border-2 p-5 text-left transition-all transform active:scale-[0.98] min-w-0",
                                selected
                                    ? option === "annual" ? "border-accent-hot bg-accent-hot/8" : "border-fg bg-fg/[0.07]"
                                    : "border-hairline bg-surface-2/30 hover:border-rule",
                            )}
                        >
                            <div className="flex items-center gap-2 mb-2 pr-8 flex-wrap">
                                <span className={cn(
                                    "font-mono text-[10px] uppercase tracking-[0.22em]",
                                    option === "annual" ? "text-accent-hot" : "text-fg-40",
                                )}>
                                    {option === "annual" ? tCard("tabAnnual") : tCard("tabMonthly")}
                                </span>
                                {option === "annual" && (
                                    <span className="font-mono text-[9px] px-1.5 py-0.5 rounded bg-accent-hot/18 text-accent-hot uppercase tracking-[0.22em] whitespace-nowrap">
                                        {tCard("save17")}
                                    </span>
                                )}
                            </div>
                            <div className="flex items-baseline gap-1 flex-wrap">
                                <span className="text-3xl font-medium text-fg tabular-nums">
                                    {option === "annual" ? "75€" : "7,50€"}
                                </span>
                                <span className="text-sm text-fg-40 font-medium">
                                    {option === "annual" ? tCard("perYear") : tCard("perMonth")}
                                </span>
                            </div>
                            <div className="text-[11px] text-fg-40 font-medium mt-2">
                                {option === "annual" ? tCard("vatAnnual") : tCard("vatMonthly")}
                            </div>
                            {selected && (
                                <div className={cn(
                                    "absolute top-3 right-3 w-5 h-5 rounded-full flex items-center justify-center",
                                    option === "annual" ? "bg-accent-hot" : "bg-fg",
                                )}>
                                    <Check className="w-3 h-3 text-surface stroke-[3]" />
                                </div>
                            )}
                        </button>
                    );
                })}
            </div>

            {error && (
                <div className="rounded-2xl border border-destructive/30 bg-destructive/8 px-5 py-4 text-[12px] leading-relaxed text-destructive space-y-2">
                    <p className="font-medium">{t("errorTitle")}</p>
                    <p className="font-mono text-[11px] break-words">{error}</p>
                    <button
                        onClick={openHosted}
                        disabled={openingHosted}
                        className="mt-1 rounded-xl border border-destructive/40 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] transition-colors hover:border-destructive disabled:opacity-40"
                    >
                        {openingHosted ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : t("openHosted")}
                    </button>
                </div>
            )}

            {loading && !error && (
                <div className="flex items-center justify-center gap-3 rounded-2xl border border-hairline bg-surface-2/40 py-12 text-[12px] text-fg-60">
                    <Loader2 className="w-4 h-4 animate-spin text-accent-ink" /> {t("preparing")}
                </div>
            )}

            {frameEmpty && !error && (
                <div className="rounded-2xl border border-soon/30 bg-soon/8 px-5 py-4 text-[12px] leading-relaxed space-y-2">
                    <p className="font-medium text-fg">{t("frameEmptyTitle")}</p>
                    <p className="text-fg-60">{t("frameEmptyBody")}</p>
                    <button
                        onClick={openHosted}
                        disabled={openingHosted}
                        className="mt-1 rounded-xl border border-hairline px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] transition-colors hover:border-rule disabled:opacity-40"
                    >
                        {openingHosted ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : t("openHosted")}
                    </button>
                </div>
            )}

            {!loading && !error && clientSecret && stripePromise && (
                // No plate of our own behind it: the iframe paints its own
                // surface from the Stripe branding settings, and a white card
                // under a dark one is what made it read as a box dropped on the
                // page. The hairline is all that frames it.
                <div ref={frameRef} className="rounded-2xl border border-hairline overflow-hidden">
                    {/* Keyed by plan: a plan change is a different session, and the
                        form has to be built again rather than updated. */}
                    <EmbeddedCheckoutProvider key={plan} stripe={stripePromise} options={{ clientSecret }}>
                        <EmbeddedCheckout className="min-h-[520px]" />
                    </EmbeddedCheckoutProvider>
                </div>
            )}

            <p className="flex items-start gap-2 text-[11px] leading-relaxed text-fg-40">
                <ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {t("secure")}
            </p>
        </div>
    );
}
