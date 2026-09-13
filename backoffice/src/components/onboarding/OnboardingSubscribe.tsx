"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { EmbeddedCheckout, EmbeddedCheckoutProvider } from "@stripe/react-stripe-js";
import { AlertTriangle, Check, CreditCard, Gift, Loader2, ShieldCheck } from "lucide-react";

import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { REWARD_MONTHS } from "@/lib/referral";
import { addMonths } from "@/lib/referral-reward";

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

type Money = { amount_cents: number; currency: string };

type SessionResponse = {
    client_secret?: string;
    publishable_key?: string | null;
    url?: string;
    error?: string;
    code?: string;
};

/** The checkout's 409: Stripe already holds a subscription for this connection,
 *  paid or not (past_due and unpaid get it too). Not a failure to retry. */
const ALREADY_SUBSCRIBED = "already_subscribed";

export default function OnboardingSubscribe({ source, connectionKey, returnSlug, onSubscribed }: Props) {
    const t = useTranslations("onboardingSubscribe");
    const tCard = useTranslations("subscriptionCard");
    const tRef = useTranslations("referral");
    const locale = useLocale();
    const params = useSearchParams();

    const [plan, setPlan] = useState<Plan>("annual");
    const [clientSecret, setClientSecret] = useState<string | null>(null);
    const [publishableKey, setPublishableKey] = useState<string | null>(null);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(true);
    const [openingHosted, setOpeningHosted] = useState(false);
    // What this pair actually costs. Asked of the server, which reads the same
    // Stripe price the checkout charges: the figures used to be written into the
    // markup, and were only ever true of one product.
    const [prices, setPrices] = useState<{ monthly: Money | null; annual: Money | null } | null>(null);

    useEffect(() => {
        let alive = true;
        fetch(`/api/billing/price?source=${encodeURIComponent(source)}`)
            .then(r => (r.ok ? r.json() : null))
            .then((d: any) => { if (alive && d) setPrices({ monthly: d.monthly ?? null, annual: d.annual ?? null }); })
            .catch(() => { /* the card simply shows no figure */ });
        return () => { alive = false; };
    }, [source]);

    // An invited account's subscription opens with a Stripe trial, and until now
    // only the Stripe form said so: the plates read as a full charge today. Set
    // to the trial's length when the account is still waiting on that first
    // subscription; anything short of an explicit yes, a failed request included,
    // is the ordinary price.
    const [trialMonths, setTrialMonths] = useState<number | null>(null);
    // Whether to offer the field below. An invite link only ever reached the
    // browser that opened it: a friend who read it on their phone and signed up
    // on a laptop arrives here with nothing, and used to pay full price without
    // ever being told what went missing. Offered only while claims are open, and
    // only to an account that did not already come in through a link.
    const [canEnterCode, setCanEnterCode] = useState(false);

    /**
     * What the server says this account is owed, which is the ONLY thing this
     * page may promise.
     *
     * `invited_pending` is `state = 'pending'` and the campaign still open — the
     * very predicate `billing/checkout` uses to stamp the trial on the session.
     * Reading anything else here, including an optimistic "the claim returned
     * 200, so there must be a trial", lets the plates say "Hoje 0 €" over a
     * session that will take the full price.
     *
     * Answers whether a trial is actually pending — or null when the server
     * could not be asked, which is NOT the same as "no trial" and must not be
     * reported to the visitor as one.
     */
    const readReferral = useCallback(async (): Promise<boolean | null> => {
        try {
            const res = await fetch("/api/referral/me");
            const d: any = res.ok ? await res.json() : null;
            if (!d) return null;
            if (d.invited_pending === true) {
                const n = Number(d.trial_months);
                setTrialMonths(Number.isInteger(n) && n > 0 ? n : REWARD_MONTHS);
                setCanEnterCode(false);
                return true;
            }
            setTrialMonths(null);
            setCanEnterCode(d.campaign_open === true);
            return false;
        } catch {
            return null;
        }
    }, []);

    useEffect(() => { void readReferral(); }, [readReferral]);

    const [codeOpen, setCodeOpen] = useState(false);
    const [code, setCode] = useState("");
    const [claiming, setClaiming] = useState(false);
    const [codeError, setCodeError] = useState<string | null>(null);
    /**
     * Bumped when a code is accepted, to build the Checkout Session again.
     *
     * The two months are an absolute `trial_end` stamped on the session AS IT IS
     * CREATED, from the referral row. The session in the frame was made before
     * the code was typed, so it carries no trial: leaving it there would take the
     * card at full price and quietly spend the invite.
     */
    const [sessionNonce, setSessionNonce] = useState(0);

    const submitCode = useCallback(async () => {
        // Whitespace out of the middle too, not just the ends: a code read off a
        // phone and typed by hand arrives as "RIO-1A2B3C - 9F2B41" often enough,
        // and the parser would call that invalid and spend an attempt on it.
        const token = code.replace(/\s+/g, "");
        if (!token || claiming) return;
        setClaiming(true);
        setCodeError(null);
        try {
            const res = await fetch("/api/referral/claim", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token }),
            });
            const json: any = await res.json().catch(() => ({}));
            if (!res.ok) {
                // The server's own word, in the visitor's language. Anything this
                // build has no sentence for keeps the generic line.
                const refusal = typeof json.refusal === "string" ? json.refusal : null;
                setCodeError(refusal && tRef.has(`refusal.${refusal}`)
                    ? tRef(`refusal.${refusal}`)
                    : t("inviteCodeFailed"));
                return;
            }
            // 200 is not the same as "a trial is coming". The route answers a
            // replay of a code this account already used with 200 {already:true},
            // above the rules and on purpose — and an account whose referral has
            // since been paid out, or voided, is exactly who gets offered this
            // field. Believing the status there put "Hoje 0 €" on the plates over
            // a session that charges in full. So ask what is actually pending.
            const granted = await readReferral();
            if (granted === false) {
                setCodeError(tRef.has("refusal.already") ? tRef("refusal.already") : t("inviteCodeFailed"));
                return;
            }
            // true, or null for "could not ask". Either way the session is built
            // again, because the session is made from the referral row and not
            // from anything believed here: if a trial is owed it gets stamped,
            // and if it is not, Stripe shows the real amount. Only the banner
            // waits for a yes.
            setCode("");
            setSessionNonce(n => n + 1);
        } catch {
            setCodeError(t("inviteCodeFailed"));
        } finally {
            setClaiming(false);
        }
    }, [code, claiming, t, tRef, readReferral]);

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
        if (res.status === 409 && json.code === ALREADY_SUBSCRIBED) throw new Error(ALREADY_SUBSCRIBED);
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
        // sessionNonce: a code accepted after this ran needs the session rebuilt,
        // because the trial is stamped at creation.
    }, [plan, createSession, returnedSessionId, sessionNonce]);

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
        // Not while a code is being claimed: the frame is unmounted on purpose
        // then, and this would time out against its own absence and offer the
        // hosted page as though Stripe had failed to load.
        if (!clientSecret || !stripePromise || claiming) return;
        setFrameEmpty(false);
        const timer = setTimeout(() => {
            setFrameEmpty(!frameRef.current?.querySelector("iframe"));
        }, 8000);
        return () => clearTimeout(timer);
    }, [clientSecret, stripePromise, claiming]);

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
                    // An invitee comes back in a paying Stripe trial, so "trialing" is done too.
                    if (sub?.ui_state === "active" || sub?.ui_state === "trialing" || sub?.ui_state === "exempt") {
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

    const intlLocale = locale === "en" ? "en-GB" : "pt-PT";
    const money = (m: Money | null | undefined) =>
        m ? new Intl.NumberFormat(intlLocale, {
            style: "currency", currency: (m.currency || "eur").toUpperCase(),
            minimumFractionDigits: m.amount_cents % 100 === 0 ? 0 : 2,
        }).format(m.amount_cents / 100) : null;

    // "equivale a X/mês", from the yearly price rather than from a sentence
    // written when the yearly price was 75 €.
    const monthlyEquivalent = prices?.annual
        ? money({ amount_cents: Math.round(prices.annual.amount_cents / 12), currency: prices.annual.currency })
        : null;

    // Only claimed when the year really is cheaper than twelve months of it.
    const savedPercent = prices?.annual && prices?.monthly && prices.monthly.amount_cents > 0
        ? (() => {
            const pct = Math.round((1 - prices.annual!.amount_cents / (prices.monthly!.amount_cents * 12)) * 100);
            return pct >= 1 ? pct : null;
        })()
        : null;

    // The first charge: the trial counted in calendar months with the same
    // month-end clamp the inviter's reward uses, so 31 December plus two is 28
    // February on both sides of the same invitation.
    const zeroToday = money({ amount_cents: 0, currency: prices?.annual?.currency ?? "eur" });
    const firstCharge = trialMonths
        ? new Intl.DateTimeFormat(intlLocale, { dateStyle: "long" })
            .format(new Date(addMonths(new Date().toISOString(), trialMonths)))
        : null;

    return (
        <div className="space-y-5">
            {trialMonths && (
                <div className="flex items-start gap-3.5 rounded-2xl border border-accent-hot/25 bg-accent-hot/8 px-5 py-4 text-[12px] leading-relaxed text-fg-60">
                    <Gift className="w-4 h-4 shrink-0 mt-0.5 text-accent-hot" />
                    <div className="min-w-0 space-y-1">
                        <p className="font-medium text-fg">{t("referralTitle", { months: trialMonths, amount: zeroToday ?? "0 €" })}</p>
                        <p>{t("referralBody", { months: trialMonths, date: firstCharge ?? "" })}</p>
                    </div>
                </div>
            )}

            {canEnterCode && (
                <div className="rounded-2xl border border-hairline bg-surface-2/30 px-5 py-4">
                    {!codeOpen ? (
                        <button
                            type="button"
                            onClick={() => setCodeOpen(true)}
                            className="flex items-center gap-2 text-[12px] font-medium text-fg-60 transition-colors hover:text-fg"
                        >
                            <Gift className="w-4 h-4 text-accent-ink" />
                            {t("inviteCodeToggle")}
                        </button>
                    ) : (
                        <div className="space-y-2.5">
                            <label htmlFor="rioko-invite-code" className="flex items-center gap-2 text-[12px] font-medium text-fg">
                                <Gift className="w-4 h-4 shrink-0 text-accent-ink" />
                                {t("inviteCodeLabel")}
                            </label>
                            <div className="flex flex-col gap-2 sm:flex-row">
                                <input
                                    id="rioko-invite-code"
                                    value={code}
                                    onChange={e => setCode(e.target.value.toUpperCase())}
                                    onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void submitCode(); } }}
                                    placeholder={t("inviteCodePlaceholder")}
                                    autoComplete="off"
                                    spellCheck={false}
                                    disabled={claiming}
                                    className="min-w-0 flex-1 rounded-xl border border-hairline bg-surface px-3.5 py-2.5 font-mono text-[13px] uppercase tracking-[0.08em] text-fg placeholder:text-fg-40 focus:border-accent focus:outline-none disabled:opacity-50"
                                />
                                <button
                                    type="button"
                                    onClick={() => void submitCode()}
                                    disabled={claiming || !code.trim()}
                                    className="flex shrink-0 items-center justify-center gap-2 rounded-xl bg-fg px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.18em] text-surface transition-colors hover:bg-accent hover:text-on-accent disabled:opacity-50"
                                >
                                    {claiming && <Loader2 className="w-4 h-4 animate-spin" />}
                                    {t("inviteCodeApply")}
                                </button>
                            </div>
                            {codeError && <p role="alert" className="text-[12px] text-destructive">{codeError}</p>}
                            <p className="text-[11px] leading-relaxed text-fg-40">
                                {t("inviteCodeHint", { months: REWARD_MONTHS })}
                            </p>
                        </div>
                    )}
                </div>
            )}

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
                                {option === "annual" && savedPercent !== null && (
                                    <span className="font-mono text-[9px] px-1.5 py-0.5 rounded bg-accent-hot/18 text-accent-hot uppercase tracking-[0.22em] whitespace-nowrap">
                                        {tCard("savePercent", { pct: savedPercent })}
                                    </span>
                                )}
                            </div>
                            <div className="flex items-baseline gap-1 flex-wrap">
                                <span className="text-3xl font-medium text-fg tabular-nums">
                                    {money(option === "annual" ? prices?.annual : prices?.monthly) ?? "—"}
                                </span>
                                <span className="text-sm text-fg-40 font-medium">
                                    {option === "annual" ? tCard("perYear") : tCard("perMonth")}
                                </span>
                            </div>
                            <div className="text-[11px] text-fg-40 font-medium mt-2">
                                {option === "annual"
                                    ? monthlyEquivalent
                                        ? tCard("vatAnnualEquivalent", { amount: monthlyEquivalent })
                                        : tCard("vatAnnualPlain")
                                    : tCard("vatMonthly")}
                            </div>
                            {trialMonths && (
                                <div className="mt-3 flex items-center gap-2 flex-wrap text-[11px] font-medium">
                                    <span className="font-mono text-[9px] px-1.5 py-0.5 rounded bg-accent-hot/18 text-accent-hot uppercase tracking-[0.22em] whitespace-nowrap">
                                        {t("referralPlateToday", { amount: zeroToday ?? "0 €" })}
                                    </span>
                                    <span className="text-fg-60">{t("referralPlateAfter", { months: trialMonths })}</span>
                                </div>
                            )}
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

            {error === ALREADY_SUBSCRIBED && (
                // Said as what it is: there is nothing to retry and no hosted page
                // to offer, because that one would be refused the same way. Not
                // "all is well" either: a past_due or unpaid subscription lands
                // here too, and that merchant does owe money, on the subscription
                // they already have, which is paid and re-carded in Faturação.
                <div className="flex items-start gap-3.5 rounded-2xl border border-accent/20 bg-accent/5 px-5 py-4 text-[12px] leading-relaxed text-fg-60">
                    <CreditCard className="w-4 h-4 shrink-0 mt-0.5 text-accent-ink" />
                    <div className="min-w-0 space-y-1">
                        <p className="font-medium text-fg">{t("alreadySubscribedTitle")}</p>
                        <p>{t("alreadySubscribedBody")}</p>
                        <Link
                            href="/faturacao"
                            className="mt-2 inline-block rounded-xl border border-hairline px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-fg transition-colors hover:border-rule"
                        >
                            {tCard("manageBilling")}
                        </Link>
                    </div>
                </div>
            )}

            {error && error !== ALREADY_SUBSCRIBED && (
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

            {/* `!claiming`: the form on screen belongs to a session made BEFORE
                the code was typed, so it carries no trial. Disabling the input and
                the Apply button left it fully payable for the whole round trip —
                a merchant with the card already filled could press Stripe's own
                button a second later and be charged in full. It comes straight
                back, from the same client secret, if the code is refused. */}
            {!loading && !error && !claiming && clientSecret && stripePromise && (
                // No plate of our own behind it: the iframe paints its own
                // surface from the Stripe branding settings, and a white card
                // under a dark one is what made it read as a box dropped on the
                // page. The hairline is all that frames it.
                <div ref={frameRef} className="rounded-2xl border border-hairline overflow-hidden">
                    {/* Keyed by plan: a plan change is a different session, and the
                        form has to be built again rather than updated. */}
                    {/* Keyed on the session, not just the plan. The provider reads
                        clientSecret once, at mount, and ignores it changing — which
                        is why the plan was already a key. A code accepted here
                        fetches a new session WITH the trial, and without the nonce
                        in this key the old trial-less iframe stayed mounted and took
                        the card at full price. */}
                    <EmbeddedCheckoutProvider key={`${plan}:${sessionNonce}`} stripe={stripePromise} options={{ clientSecret }}>
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
