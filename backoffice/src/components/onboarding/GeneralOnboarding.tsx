"use client";

import { useCallback, useEffect, useState } from "react";
import { useClerk, useUser } from "@clerk/nextjs";
import { useLocale, useTranslations } from "next-intl";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import Image from "next/image";
import {
    AlertTriangle, ArrowRight, Building2, Check, ChevronDown, Globe, Loader2, Lock,
    LogOut, MapPin, Phone, Plug, ShieldCheck, Sparkles, User, UserPlus,
} from "lucide-react";
import PlatformIcon from "@/components/PlatformIcon";
import { Link, useRouter } from "@/i18n/navigation";
import { ThemedLogo } from "@/components/ThemedLogo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LangToggle } from "@/components/landing/LangToggle";
import { LegalLinks } from "@/components/LegalLinks";
import {
    INVOICING_PLATFORMS, PAYMENT_PLATFORMS, type Platform,
    afterOnboardingPath, canConnectPair, invoicingPlatform, onboardingPath, paymentPlatform,
} from "@/lib/platforms";

import { cn } from "@/lib/utils";

/**
 * The onboarding a new client meets right after signing up.
 *
 * It replaced the company form that used to appear inside the dashboard. That
 * form asked for tax details and then left the merchant on an empty dashboard
 * with no idea what to do next; this asks the same details AND what they came
 * to connect, then takes them there.
 *
 * Deliberately the same six-step furniture as the guided pages under
 * /onboarding/stripe-connect-*: same header, same accordion, same progress
 * rail. A client who picks Stripe and InvoiceXpress is handed straight over to
 * one of those pages, and the handover should not look like a different
 * product.
 *
 * Where they are handed over to is NOT decided here — see afterOnboardingPath()
 * in src/lib/platforms.ts. The day the Shopify or Lodgify onboarding exists, one
 * line there is the whole change.
 */

const SUPPORT_EMAIL = "rioko@kapta.pt";

type StepId = "account" | "company" | "platforms";
const STEP_IDS: StepId[] = ["account", "company", "platforms"];

const INPUT_CLASS =
    "w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium text-fg outline-none transition-all placeholder:text-fg-40 focus:border-accent focus:ring-2 focus:ring-accent/20";

const EASE: [number, number, number, number] = [0.32, 0.72, 0, 1];

function Eyebrow({ children }: { children: React.ReactNode }) {
    return (
        <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-fg-40 flex items-center gap-2 ml-1">
            <span className="w-1 h-1 rounded-full bg-accent" />
            {children}
        </span>
    );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
    return (
        <div className="space-y-2.5">
            <label htmlFor={htmlFor} className="block">
                <Eyebrow>{label}</Eyebrow>
            </label>
            {children}
        </div>
    );
}

function Notice({ tone, children }: { tone: "info" | "good" | "bad"; children: React.ReactNode }) {
    const palette = {
        info: "border-accent/20 bg-accent/5 text-fg-60",
        good: "border-accent-hot/25 bg-accent-hot/8 text-fg-60",
        bad: "border-destructive/30 bg-destructive/8 text-destructive",
    }[tone];
    const Icon = tone === "bad" ? AlertTriangle : tone === "good" ? Check : ShieldCheck;
    const iconColor = tone === "bad" ? "text-destructive" : tone === "good" ? "text-accent-hot" : "text-accent-ink";
    return (
        <div
            role={tone === "bad" ? "alert" : undefined}
            className={cn("flex items-start gap-3.5 rounded-2xl border px-5 py-4 text-[12px] leading-relaxed", palette)}
        >
            <Icon className={cn("w-4 h-4 shrink-0 mt-0.5", iconColor)} aria-hidden />
            <div className="min-w-0 space-y-1">{children}</div>
        </div>
    );
}

function PrimaryButton({
    onClick, disabled, busy, children, type = "button",
}: {
    onClick?: () => void; disabled?: boolean; busy?: boolean;
    children: React.ReactNode; type?: "button" | "submit";
}) {
    return (
        <button
            type={type}
            onClick={onClick}
            disabled={disabled || busy}
            className="w-full min-h-[3.25rem] py-4 rounded-2xl bg-fg text-surface font-mono text-xs uppercase tracking-[0.18em] flex items-center justify-center gap-3 transition-all duration-300 transform active:scale-[0.98] hover:bg-accent-hot disabled:opacity-30 disabled:cursor-not-allowed shadow-[0_8px_30px_-12px_color-mix(in_srgb,var(--accent)_45%,transparent)]"
        >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : children}
        </button>
    );
}

/** One platform tile. A radio, not a button: picking one un-picks the others. */
function PlatformTile({
    platform, selected, onSelect, comingSoon, available,
}: {
    platform: Platform; selected: boolean; onSelect: () => void;
    comingSoon: string; available: string;
}) {
    return (
        <button
            type="button"
            role="radio"
            aria-checked={selected}
            aria-disabled={!platform.active}
            disabled={!platform.active}
            onClick={onSelect}
            className={cn(
                "w-full min-h-[4.5rem] glass rounded-[1.75rem] px-5 py-4 border flex items-center justify-between gap-4 text-left transition-all",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                !platform.active
                    ? "opacity-40 grayscale cursor-not-allowed border-hairline"
                    : selected
                        ? "border-accent/45 bg-accent/5"
                        : "border-hairline hover:border-rule",
            )}
        >
            <span className="flex items-center gap-4 min-w-0">
                <span className={cn(
                    "w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 transition-colors",
                    selected ? "bg-accent/18 text-accent-ink" : "bg-surface-2 text-fg-40",
                )}>
                    {platform.logo
                        ? <Image
                            src={platform.logo} alt="" aria-hidden
                            width={platform.logoW} height={platform.logoH}
                            className={cn("object-contain", platform.logo.includes("-white") && "logo-adaptive")}
                        />
                        : <PlatformIcon name={platform.icon} className="w-5 h-5" aria-hidden />}
                </span>
                <span className="min-w-0">
                    <span className="block text-[15px] font-medium text-fg truncate">{platform.name}</span>
                    <span className="block font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">
                        {platform.active ? available : comingSoon}
                    </span>
                </span>
            </span>
            {!platform.active
                ? <Lock className="w-4 h-4 shrink-0 text-fg-40" aria-hidden />
                : selected
                    ? <Check className="w-4 h-4 shrink-0 text-accent-hot" aria-hidden />
                    : <span className="w-4 h-4 shrink-0 rounded-full border border-hairline-strong" aria-hidden />}
        </button>
    );
}

export default function GeneralOnboarding() {
    const t = useTranslations("generalOnboarding");
    const tReg = useTranslations("registrationForm");
    const tInt = useTranslations("integrationsIndex");
    const locale = useLocale();
    const router = useRouter();
    const reduceMotion = useReducedMotion();
    const { isLoaded: clerkLoaded, isSignedIn, user } = useUser();
    const { signOut } = useClerk();

    const [loading, setLoading] = useState(true);
    const [openStep, setOpenStep] = useState<StepId | null>(null);

    // Server-side truth, never where the merchant thinks they are: this page is
    // also the way back after a sign-up on another tab.
    const [profileDone, setProfileDone] = useState(false);
    const [acceptedAt, setAcceptedAt] = useState<string | null>(null);

    const [form, setForm] = useState({
        nif: "", name: "", company_name: "", fiscal_address: "", phone: "", website: "",
        privacy_policy_accepted: false,
    });
    const [savingProfile, setSavingProfile] = useState(false);
    const [profileError, setProfileError] = useState("");

    const [source, setSource] = useState<string | null>(null);
    const [destination, setDestination] = useState<string | null>(null);
    const [pairSaved, setPairSaved] = useState(false);
    const [routing, setRouting] = useState(false);
    const [pairError, setPairError] = useState("");

    const load = useCallback(async () => {
        // This is what creates the users row, and the profile write needs it to
        // exist: a sign-up whose Clerk webhook has not landed yet has no row.
        await fetch("/api/auth/sync", { method: "POST" }).catch(() => {});

        const profile: any = await fetch("/api/user/profile")
            .then(r => (r.ok ? r.json() : null))
            .catch(() => null);
        if (!profile) return;

        setProfileDone(profile.registration_completed === 1);
        setAcceptedAt(profile.privacy_policy_accepted_at ?? null);
        setForm(f => ({
            ...f,
            nif: profile.nif ?? f.nif,
            name: profile.name ?? f.name,
            company_name: profile.company_name ?? f.company_name,
            fiscal_address: profile.fiscal_address ?? f.fiscal_address,
            phone: profile.phone ?? f.phone,
            website: profile.website ?? f.website,
            privacy_policy_accepted: profile.privacy_policy_accepted === 1 || f.privacy_policy_accepted,
        }));
        // The pair they picked last time, so a half-finished onboarding resumes
        // where it stopped instead of asking the same question again.
        if (profile.onboarding_source_kind) setSource(profile.onboarding_source_kind);
        if (profile.onboarding_destination_kind) setDestination(profile.onboarding_destination_kind);
        setPairSaved(!!profile.onboarding_source_kind && !!profile.onboarding_destination_kind);
    }, []);

    useEffect(() => {
        if (!clerkLoaded) return;
        if (!isSignedIn) { setLoading(false); return; }
        setForm(f => ({ ...f, name: f.name || user?.fullName || "" }));
        load().finally(() => setLoading(false));
    }, [clerkLoaded, isSignedIn, user, load]);

    const done: Record<StepId, boolean> = {
        account: !!isSignedIn,
        company: profileDone,
        platforms: pairSaved,
    };
    const doneCount = STEP_IDS.filter(id => done[id]).length;
    const firstOpenIndex = STEP_IDS.findIndex(id => !done[id]);
    const currentIndex = firstOpenIndex === -1 ? STEP_IDS.length - 1 : firstOpenIndex;
    const activeStep = openStep ?? STEP_IDS[currentIndex];

    /** A company NIF starts with 5, 6, 8 or 9; only then is a legal name asked for. */
    const isCompany = ["5", "6", "8", "9"].includes(form.nif.trim()[0] ?? "");

    const pairIsConnectable = canConnectPair(source, destination);
    const pairIsGuided = onboardingPath(source, destination) !== null;
    const pairLabel = source && destination
        ? `${paymentPlatform(source)?.name ?? source} + ${invoicingPlatform(destination)?.name ?? destination}`
        : "";

    const acceptedOn = acceptedAt
        // "2026-09-11 08:20:02" is what CURRENT_TIMESTAMP writes, and it is UTC.
        // Read as UTC explicitly: left to the browser it is taken as local time
        // and the date can slide by one day either side of midnight.
        ? new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "pt-PT", { dateStyle: "long", timeZone: "UTC" })
            .format(new Date(acceptedAt.replace(" ", "T") + (acceptedAt.endsWith("Z") ? "" : "Z")))
        : null;

    /** The one write this page does. Both steps send the whole profile. */
    const saveProfile = async (extra: { onboarding_source_kind?: string; onboarding_destination_kind?: string }) => {
        const body = JSON.stringify({
            ...form,
            email: user?.primaryEmailAddress?.emailAddress ?? "",
            ...extra,
        });
        const post = () => fetch("/api/user/profile", {
            method: "POST", headers: { "Content-Type": "application/json" }, body,
        });
        let res = await post();
        // 409 is "no users row yet": the sync on load lost the race with a
        // sign-up that had only just finished. Sync again and retry once.
        if (res.status === 409) {
            await fetch("/api/auth/sync", { method: "POST" }).catch(() => {});
            res = await post();
        }
        return res;
    };

    const submitCompany = async (e: React.FormEvent) => {
        e.preventDefault();
        setSavingProfile(true);
        setProfileError("");
        try {
            const res = await saveProfile({});
            if (!res.ok) {
                setProfileError(tReg("saveError"));
                return;
            }
            setProfileDone(true);
            if (!acceptedAt) setAcceptedAt(new Date().toISOString());
            setOpenStep("platforms");
        } catch {
            setProfileError(tReg("saveError"));
        } finally {
            setSavingProfile(false);
        }
    };

    const submitPair = async () => {
        if (!source || !destination || !pairIsConnectable) return;
        setRouting(true);
        setPairError("");
        try {
            const res = await saveProfile({
                onboarding_source_kind: source,
                onboarding_destination_kind: destination,
            });
            if (!res.ok) {
                setPairError(tReg("saveError"));
                return;
            }
            setPairSaved(true);
            router.push(afterOnboardingPath(source, destination));
        } catch {
            setPairError(tReg("saveError"));
        } finally {
            setRouting(false);
        }
    };

    const authHref = (page: "sign-up" | "sign-in") => `/${locale}/${page}`;

    const bodies: Record<StepId, React.ReactNode> = {
        account: isSignedIn ? (
            <div className="space-y-5">
                <Notice tone="good">
                    <p className="font-medium text-fg">{t("account.signedInAs", { email: user?.primaryEmailAddress?.emailAddress ?? "" })}</p>
                    <p>{t("account.signedInBody")}</p>
                </Notice>
                <PrimaryButton onClick={() => setOpenStep("company")}>
                    {t("continue")} <ArrowRight className="w-4 h-4" aria-hidden />
                </PrimaryButton>
                {/* The way out of the wrong account. Everything on this page is
                    written against whoever is signed in, so a merchant who
                    arrived with a personal email, or on a colleague's session,
                    has no other way back. */}
                <button
                    type="button"
                    onClick={() => signOut({ redirectUrl: window.location.pathname })}
                    className="w-full min-h-[2.75rem] py-3.5 rounded-2xl border border-hairline text-fg-60 font-mono text-[10px] uppercase tracking-[0.18em] flex items-center justify-center gap-2 transition-colors hover:border-rule hover:text-fg"
                >
                    <LogOut className="w-3.5 h-3.5" aria-hidden /> {t("account.signOut")}
                </button>
            </div>
        ) : (
            <div className="space-y-5">
                <Notice tone="info"><p>{t("account.body")}</p></Notice>
                <a
                    href={authHref("sign-up")}
                    className="w-full min-h-[3.25rem] py-4 rounded-2xl bg-fg text-surface font-mono text-xs uppercase tracking-[0.18em] flex items-center justify-center gap-3 transition-all duration-300 transform active:scale-[0.98] hover:bg-accent-hot shadow-[0_8px_30px_-12px_color-mix(in_srgb,var(--accent)_45%,transparent)]"
                >
                    <UserPlus className="w-4 h-4" aria-hidden /> {t("account.create")}
                </a>
                <p className="text-center text-[12px] text-fg-60">
                    {t("account.haveAccount")}{" "}
                    <a href={authHref("sign-in")} className="text-accent-ink font-medium hover:text-accent-hover transition-colors">
                        {t("account.signIn")}
                    </a>
                </p>
            </div>
        ),

        company: (
            <form onSubmit={submitCompany} className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="md:col-span-2">
                    <Notice tone="info"><p>{t("company.body")}</p></Notice>
                </div>

                <div className="md:col-span-2">
                    <Field label={tReg("nifLabel")} htmlFor="ob-nif">
                        <div className="relative">
                            <ShieldCheck className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-40" aria-hidden />
                            <input
                                id="ob-nif" required inputMode="numeric" maxLength={9}
                                autoComplete="off" placeholder={tReg("nifPlaceholder")}
                                className={cn(INPUT_CLASS, "pl-14 font-mono")}
                                value={form.nif}
                                onChange={e => setForm({ ...form, nif: e.target.value.replace(/\D/g, "") })}
                            />
                        </div>
                    </Field>
                </div>

                <div className="md:col-span-2">
                    <Field label={isCompany ? tReg("companyNameLabel") : tReg("personNameLabel")} htmlFor="ob-name">
                        <div className="relative">
                            {isCompany
                                ? <Building2 className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-40" aria-hidden />
                                : <User className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-40" aria-hidden />}
                            <input
                                id="ob-name" required
                                autoComplete={isCompany ? "organization" : "name"}
                                placeholder={isCompany ? tReg("companyNamePlaceholder") : tReg("personNamePlaceholder")}
                                className={cn(INPUT_CLASS, "pl-14")}
                                value={isCompany ? form.company_name : form.name}
                                onChange={e => setForm(isCompany
                                    ? { ...form, company_name: e.target.value }
                                    : { ...form, name: e.target.value })}
                            />
                        </div>
                    </Field>
                </div>

                <div className="md:col-span-2">
                    <Field label={tReg("addressLabel")} htmlFor="ob-address">
                        <div className="relative">
                            <MapPin className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-40" aria-hidden />
                            <input
                                id="ob-address" required autoComplete="street-address"
                                placeholder={tReg("addressPlaceholder")}
                                className={cn(INPUT_CLASS, "pl-14")}
                                value={form.fiscal_address}
                                onChange={e => setForm({ ...form, fiscal_address: e.target.value })}
                            />
                        </div>
                    </Field>
                </div>

                <Field label={tReg("phoneLabel")} htmlFor="ob-phone">
                    <div className="relative">
                        <Phone className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-40" aria-hidden />
                        <input
                            id="ob-phone" type="tel" autoComplete="tel"
                            className={cn(INPUT_CLASS, "pl-14")}
                            value={form.phone}
                            onChange={e => setForm({ ...form, phone: e.target.value })}
                        />
                    </div>
                </Field>

                <Field label={tReg("websiteLabel")} htmlFor="ob-website">
                    <div className="relative">
                        <Globe className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-40" aria-hidden />
                        <input
                            id="ob-website" type="url" autoComplete="url"
                            placeholder={tReg("websitePlaceholder")}
                            className={cn(INPUT_CLASS, "pl-14")}
                            value={form.website}
                            onChange={e => setForm({ ...form, website: e.target.value })}
                        />
                    </div>
                </Field>

                <label className="md:col-span-2 flex items-start gap-3 cursor-pointer group py-1">
                    <input
                        required type="checkbox" className="peer sr-only"
                        checked={form.privacy_policy_accepted}
                        onChange={e => setForm({ ...form, privacy_policy_accepted: e.target.checked })}
                    />
                    <span className="mt-0.5 w-6 h-6 shrink-0 rounded-lg border-2 border-hairline bg-surface-2 flex items-center justify-center transition-all group-hover:border-accent/50 peer-checked:bg-accent peer-checked:border-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent/45 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background">
                        <Check className="w-3.5 h-3.5 text-on-accent opacity-0 peer-checked:opacity-100 transition-opacity" aria-hidden />
                    </span>
                    <span className="text-[13px] font-medium text-fg-60 group-hover:text-fg transition-colors">
                        {tReg("privacyAccept")}{" "}
                        <Link href="/privacy" className="text-accent-ink hover:text-accent-hover transition-colors">
                            {t("company.privacyLink")}
                        </Link>
                        {acceptedOn && (
                            <span className="block mt-1 font-mono text-[10px] uppercase tracking-[0.18em] text-fg-40">
                                {t("company.acceptedOn", { date: acceptedOn })}
                            </span>
                        )}
                    </span>
                </label>

                {profileError && (
                    <div className="md:col-span-2"><Notice tone="bad"><p>{profileError}</p></Notice></div>
                )}

                <div className="md:col-span-2">
                    <PrimaryButton type="submit" busy={savingProfile}>
                        {profileDone ? t("company.update") : t("continue")} <ArrowRight className="w-4 h-4" aria-hidden />
                    </PrimaryButton>
                </div>
            </form>
        ),

        platforms: (
            <div className="space-y-7">
                <Notice tone="info"><p>{t("platforms.body")}</p></Notice>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-7">
                    <div className="space-y-3" role="radiogroup" aria-labelledby="ob-payment-label">
                        <h3 id="ob-payment-label" className="font-mono text-[10px] uppercase tracking-[0.22em] text-fg-40 ml-1">
                            {tInt("paymentPlatform")}
                        </h3>
                        {PAYMENT_PLATFORMS.map(p => (
                            <PlatformTile
                                key={p.id} platform={p}
                                selected={source === p.id}
                                onSelect={() => setSource(p.id)}
                                available={tInt("available")} comingSoon={tInt("comingSoon")}
                            />
                        ))}
                    </div>

                    <div className="space-y-3" role="radiogroup" aria-labelledby="ob-invoicing-label">
                        <h3 id="ob-invoicing-label" className="font-mono text-[10px] uppercase tracking-[0.22em] text-fg-40 ml-1">
                            {tInt("invoicingPlatform")}
                        </h3>
                        {INVOICING_PLATFORMS.map(p => (
                            <PlatformTile
                                key={p.id} platform={p}
                                selected={destination === p.id}
                                onSelect={() => setDestination(p.id)}
                                available={tInt("available")} comingSoon={tInt("comingSoon")}
                            />
                        ))}
                    </div>
                </div>

                <AnimatePresence initial={false}>
                    {source && destination && (
                        <motion.div
                            key="summary"
                            initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
                            transition={{ duration: 0.3, ease: EASE }}
                            className="space-y-5"
                        >
                            <div className={cn(
                                "rounded-[2rem] border px-6 py-6 space-y-2",
                                pairIsConnectable ? "border-accent/25 bg-accent/5" : "border-hairline bg-surface-2/50",
                            )}>
                                <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-fg-40">
                                    {t("platforms.summaryLabel")}
                                </p>
                                <p className="text-lg font-medium tracking-tight text-fg">{pairLabel}</p>
                                <p className="text-[12px] leading-relaxed text-fg-60">
                                    {!pairIsConnectable
                                        ? t("platforms.summaryUnavailable")
                                        : pairIsGuided
                                            ? t("platforms.summaryGuided")
                                            : t("platforms.summaryDirect")}
                                </p>
                            </div>

                            {pairError && <Notice tone="bad"><p>{pairError}</p></Notice>}

                            {pairIsConnectable ? (
                                <PrimaryButton onClick={submitPair} busy={routing}>
                                    {pairIsGuided ? t("platforms.ctaGuided") : t("platforms.ctaDirect")}
                                    <ArrowRight className="w-4 h-4" aria-hidden />
                                </PrimaryButton>
                            ) : (
                                <PrimaryButton disabled>{tInt("unavailableCombo")}</PrimaryButton>
                            )}
                        </motion.div>
                    )}
                </AnimatePresence>

                <p className="text-[11px] leading-relaxed text-fg-40">{t("platforms.note")}</p>
            </div>
        ),
    };

    const stepIcon: Record<StepId, typeof UserPlus> = {
        account: UserPlus, company: Building2, platforms: Plug,
    };

    if (!clerkLoaded || loading) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <Loader2 className="w-10 h-10 animate-spin text-accent-ink opacity-50" aria-label={t("loading")} />
            </div>
        );
    }

    return (
        <div className="min-h-screen">
            <header className="sticky top-0 z-30 border-b border-hairline bg-background/85 backdrop-blur-xl">
                <div className="mx-auto max-w-3xl px-5 sm:px-8 h-16 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                        <ThemedLogo
                            nightSrc="/images/logo-rioko-white.webp"
                            daySrc="/images/logo-rioko-black.webp"
                            alt="Rioko" width={120} height={32} priority className="h-4 sm:h-5 w-auto"
                        />
                        <span className="hidden sm:block h-4 w-px bg-hairline-strong" />
                        <span className="hidden sm:block font-mono text-[10px] uppercase tracking-[0.22em] text-fg-40 truncate">
                            {t("headerTag")}
                        </span>
                    </div>
                    <div className="flex items-center gap-1.5 sm:gap-2">
                        {/* The way out of the wrong account, from anywhere on the
                            page. It also lives inside step one, but that step
                            collapses the moment it is done — and a merchant who
                            signed up with the wrong email only notices later. */}
                        {isSignedIn && (
                            <button
                                type="button"
                                onClick={() => signOut({ redirectUrl: window.location.pathname })}
                                title={t("account.signOut")}
                                aria-label={t("account.signOut")}
                                className="h-9 px-2.5 sm:px-3 rounded-full border border-hairline text-fg-40 hover:text-fg hover:border-rule transition-colors flex items-center gap-2 max-w-[11rem]"
                            >
                                <LogOut className="w-3.5 h-3.5 shrink-0" aria-hidden />
                                <span className="hidden md:block font-mono text-[10px] uppercase tracking-[0.18em] truncate">
                                    {user?.primaryEmailAddress?.emailAddress ?? t("account.signOut")}
                                </span>
                            </button>
                        )}
                        <ThemeToggle />
                        <LangToggle />
                    </div>
                </div>
                <div className="h-[2px] bg-hairline">
                    <motion.div
                        className="h-full bg-accent"
                        initial={false}
                        animate={{ width: `${(doneCount / STEP_IDS.length) * 100}%` }}
                        transition={reduceMotion ? { duration: 0 } : { duration: 0.6, ease: EASE }}
                    />
                </div>
            </header>

            <main className="mx-auto max-w-3xl px-5 sm:px-8 pb-24">
                <section className="pt-14 sm:pt-20 pb-10 space-y-5">
                    <span className="inline-flex items-center gap-2 rounded-full border border-accent/20 bg-accent/10 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.22em] text-accent-ink">
                        <Sparkles className="w-3 h-3" aria-hidden /> {t("eyebrow")}
                    </span>
                    <h1 className="text-[2rem] sm:text-5xl font-medium tracking-tight leading-[1.05]">{t("title")}</h1>
                    <p className="text-base sm:text-lg text-fg-60 leading-relaxed max-w-2xl">{t("subtitle")}</p>
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                        {["trust1", "trust2", "trust3"].map(k => (
                            <span key={k} className="inline-flex items-center gap-2 rounded-full border border-hairline bg-veil px-3 py-1.5 text-[11px] font-medium text-fg-60">
                                <Check className="w-3 h-3 text-accent-hot" aria-hidden /> {t(k)}
                            </span>
                        ))}
                    </div>
                    <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-fg-40 pt-2" aria-live="polite">
                        {t("progress", { current: currentIndex + 1, total: STEP_IDS.length })}
                    </p>
                </section>

                <div className="space-y-4">
                    {STEP_IDS.map((id, index) => {
                        const Icon = stepIcon[id];
                        const isDone = done[id];
                        const isLocked = index > currentIndex;
                        const isOpen = activeStep === id && !isLocked;
                        return (
                            <motion.section
                                key={id}
                                layout={!reduceMotion}
                                transition={{ duration: reduceMotion ? 0 : 0.4, ease: EASE }}
                                className={cn(
                                    "glass rounded-[2rem] overflow-hidden transition-opacity duration-500",
                                    isDone && "border-accent-hot/25",
                                    isLocked && "opacity-55",
                                )}
                            >
                                <button
                                    type="button"
                                    disabled={isLocked}
                                    aria-expanded={isOpen}
                                    aria-controls={`step-${id}`}
                                    onClick={() => setOpenStep(isOpen ? null : id)}
                                    className="w-full flex items-center gap-4 px-5 sm:px-8 py-6 text-left disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset"
                                >
                                    <span className={cn(
                                        "w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 ring-1 transition-colors",
                                        isDone
                                            ? "bg-accent-hot/12 text-accent-hot ring-accent-hot/30"
                                            : isLocked
                                                ? "bg-surface-2/60 text-fg-40 ring-hairline"
                                                : "bg-accent/10 text-accent-ink ring-accent/25",
                                    )}>
                                        {isDone ? <Check className="w-5 h-5" aria-hidden /> : isLocked ? <Lock className="w-4 h-4" aria-hidden /> : <Icon className="w-5 h-5" aria-hidden />}
                                    </span>

                                    <span className="flex-1 min-w-0">
                                        <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-fg-40">
                                            {String(index + 1).padStart(2, "0")}
                                            <span className="h-px w-4 bg-hairline-strong" />
                                            {isDone ? t("statusDone") : isLocked ? t("statusLocked") : t("statusNow")}
                                        </span>
                                        <span className="block text-base sm:text-lg font-medium tracking-tight mt-1">{t(`${id}.title`)}</span>
                                        <span className="block text-[12px] text-fg-60 mt-0.5 leading-relaxed">{t(`${id}.desc`)}</span>
                                    </span>

                                    <ChevronDown className={cn("w-4 h-4 shrink-0 text-fg-40 transition-transform duration-300", isOpen && "rotate-180")} aria-hidden />
                                </button>

                                <AnimatePresence initial={false}>
                                    {isOpen && (
                                        <motion.div
                                            key="body"
                                            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                                            animate={{ height: "auto", opacity: 1 }}
                                            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
                                            transition={{ duration: reduceMotion ? 0 : 0.35, ease: EASE }}
                                            className="overflow-hidden"
                                        >
                                            <div id={`step-${id}`} className="border-t border-hairline px-5 sm:px-8 py-7">
                                                {bodies[id]}
                                            </div>
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </motion.section>
                        );
                    })}
                </div>

                <footer className="mt-12 flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-t border-hairline pt-8">
                    <p className="text-[12px] text-fg-60 leading-relaxed">
                        {t("help.body")}{" "}
                        <a href={`mailto:${SUPPORT_EMAIL}`} className="text-accent-ink font-medium hover:text-accent-hover transition-colors">
                            {SUPPORT_EMAIL}
                        </a>
                    </p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg-40">
                        <LegalLinks className="hover:text-fg-60 transition-colors" />
                    </div>
                </footer>
            </main>
        </div>
    );
}
