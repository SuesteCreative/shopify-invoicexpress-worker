"use client";

import { useCallback, useEffect, useState } from "react";
import { useClerk, useUser } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { AnimatePresence, motion } from "framer-motion";
import Image from "next/image";
import {
    AlertTriangle, ArrowRight, Building2, Check, ChevronDown, CreditCard,
    Globe, Loader2, Lock, LogOut, MapPin, Phone, Settings2, ShieldCheck, Sparkles, User,
    UserPlus,
} from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { Link } from "@/i18n/navigation";
import OnboardingSubscribe from "@/components/onboarding/OnboardingSubscribe";
import { ThemedLogo } from "@/components/ThemedLogo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LangToggle } from "@/components/landing/LangToggle";
import { LegalLinks } from "@/components/LegalLinks";
import { RETURN_SLUG_ONBOARDING_CONNECT_IX } from "@/lib/oauth-return";
import { VAT_EXEMPTION_OPTIONS } from "@/lib/vat-exemptions";
import { ixSubdomain } from "@/lib/ix-account";

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

/**
 * The client-facing onboarding for Stripe Connect → InvoiceXpress.
 *
 * The sibling of the Connect → Moloni page, and deliberately the same six
 * steps on the same endpoints: sign up, company details, authorise Stripe,
 * connect InvoiceXpress, invoicing settings, subscribe. Only the fourth step
 * differs, because InvoiceXpress has no OAuth: an account name and an API key
 * are typed, and then VERIFIED against InvoiceXpress before the step is called
 * done — a key that was pasted with a stray space is the most common way this
 * flow ends in silence.
 *
 * Every step reads its state back from the server rather than trusting where
 * the merchant thinks they are: the Stripe step leaves the site entirely, and a
 * flow that resumed from local state would resume in the wrong place.
 */

const SOURCE_KIND = "stripe_connect";
const DESTINATION_KIND = "invoicexpress";
const CONNECTION_KEY = "stripe_connect:invoicexpress";
const SUPPORT_EMAIL = "rioko@kapta.pt";

type StepId = "account" | "company" | "stripe" | "ix" | "settings" | "subscribe";
const STEP_IDS: StepId[] = ["account", "company", "stripe", "ix", "settings", "subscribe"];

const INPUT_CLASS =
    "w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium text-fg outline-none transition-all placeholder:text-fg-40 focus:border-accent focus:ring-2 focus:ring-accent/20";

function Eyebrow({ children }: { children: React.ReactNode }) {
    return (
        <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-fg-40 flex items-center gap-2 ml-1">
            <span className="w-1 h-1 rounded-full bg-accent" />
            {children}
        </span>
    );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
    return (
        <div className="space-y-2.5">
            <Eyebrow>{label}</Eyebrow>
            {children}
            {hint && <p className="text-[11px] leading-relaxed text-fg-40 ml-1">{hint}</p>}
        </div>
    );
}

function Switch({
    checked, onChange, label, hint,
}: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            onClick={() => onChange(!checked)}
            className="w-full flex items-start gap-4 rounded-2xl border border-hairline bg-surface-2/40 px-5 py-4 text-left transition-colors hover:border-rule"
        >
            <span className={cn("mt-0.5 h-6 w-11 shrink-0 rounded-full p-0.5 transition-colors duration-300", checked ? "bg-accent-hot" : "bg-track-off")}>
                <span className={cn("block h-5 w-5 rounded-full bg-media-plate transition-transform duration-300", checked && "translate-x-5")} />
            </span>
            <span className="min-w-0">
                <span className="block text-sm font-medium text-fg">{label}</span>
                <span className="block text-[11px] leading-relaxed text-fg-60 mt-0.5">{hint}</span>
            </span>
        </button>
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
        <div className={cn("flex items-start gap-3.5 rounded-2xl border px-5 py-4 text-[12px] leading-relaxed", palette)}>
            <Icon className={cn("w-4 h-4 shrink-0 mt-0.5", iconColor)} />
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
            className="w-full py-4 rounded-2xl bg-fg text-surface font-mono text-xs uppercase tracking-[0.18em] flex items-center justify-center gap-3 transition-all duration-300 transform active:scale-[0.98] hover:bg-accent-hot disabled:opacity-30 disabled:cursor-not-allowed shadow-[0_8px_30px_-12px_color-mix(in_srgb,var(--accent)_45%,transparent)]"
        >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : children}
        </button>
    );
}

export default function ConnectIxOnboarding() {
    const t = useTranslations("connectIxOnboarding");
    const tReg = useTranslations("registrationForm");
    const tWiz = useTranslations("stripeConnectMoloniSetup");
    const tIx = useTranslations("stripeIxSetup");
    const tSub = useTranslations("onboardingSubscribe");
    const locale = useLocale();
    const { isLoaded: clerkLoaded, isSignedIn, user } = useUser();
    const { signOut } = useClerk();
    const params = useSearchParams();

    const [loading, setLoading] = useState(true);
    const [openStep, setOpenStep] = useState<StepId | null>(null);

    // Server-side truth for every step.
    const [profileDone, setProfileDone] = useState(false);
    const [stripeConnected, setStripeConnected] = useState(false);
    const [stripeAccountId, setStripeAccountId] = useState("");
    const [ixSaved, setIxSaved] = useState(false);
    const [connectionActive, setConnectionActive] = useState(false);
    const [subActive, setSubActive] = useState(false);

    // Step 2 — the company details, written to the profile the dashboard reads.
    const [form, setForm] = useState({
        nif: "", name: "", company_name: "", fiscal_address: "", phone: "", website: "",
        privacy_policy_accepted: false,
    });
    const [savingProfile, setSavingProfile] = useState(false);
    const [profileError, setProfileError] = useState("");

    // Step 4 — the InvoiceXpress account these documents are issued from.
    const [ixAccount, setIxAccount] = useState("");
    const [ixApiKey, setIxApiKey] = useState("");
    const [ixVerified, setIxVerified] = useState(false);

    // Step 5 — invoicing settings, which belong to THIS connection.
    const [sequenceName, setSequenceName] = useState("");
    const [documentType, setDocumentType] = useState<"invoice" | "invoice_receipt">("invoice_receipt");
    const [vatIncluded, setVatIncluded] = useState(true);
    const [autoFinalize, setAutoFinalize] = useState(false);
    const [exemptionReason, setExemptionReason] = useState("M01");

    const [busy, setBusy] = useState<"stripe" | "ix" | "settings" | null>(null);
    const [stripeError, setStripeError] = useState("");
    const [ixError, setIxError] = useState("");
    const [settingsError, setSettingsError] = useState("");

    const load = useCallback(async () => {
        // This call is what creates the users row, and the profile write needs it
        // to exist: a sign-up whose Clerk webhook has not landed yet has no row.
        await fetch("/api/auth/sync", { method: "POST" }).catch(() => {});

        const [profile, connect, integ, source, sub] = await Promise.all([
            fetch("/api/user/profile").then(r => (r.ok ? r.json() : null)).catch(() => null),
            fetch("/api/integrations/stripe-connect").then(r => r.json()).catch(() => ({})),
            fetch("/api/integrations").then(r => r.json()).catch(() => ({})),
            fetch(`/api/integrations/stripe-source?source_kind=${SOURCE_KIND}`).then(r => r.json()).catch(() => ({})),
            fetch(`/api/billing/subscription?connection_key=${encodeURIComponent(CONNECTION_KEY)}`).then(r => r.json()).catch(() => ({})),
        ]) as any[];

        if (profile) {
            setProfileDone(profile.registration_completed === 1);
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
        }

        const conn = connect?.connection;
        setStripeConnected(!!conn?.stripe?.connected);
        setStripeAccountId(conn?.stripe?.stripe_account_id ?? "");

        // InvoiceXpress credentials live on the legacy row: one IX account per
        // Rioko account, shared by every connection that files into it.
        if (integ?.ix_account_name) setIxAccount(String(integ.ix_account_name));
        if (integ?.ix_api_key) setIxApiKey(String(integ.ix_api_key));
        setIxSaved(!!integ?.ix_account_name && !!integ?.ix_api_key);
        setIxVerified(integ?.ix_authorized === 1);

        // The fiscal identity this connection states for itself. Absent means
        // "inherit the account's legacy row", which is what the worker does.
        const fiscal = source?.connection?.fiscal ?? {};
        if (typeof fiscal.ix_sequence_name === "string") setSequenceName(fiscal.ix_sequence_name);
        if (fiscal.ix_document_type === "invoice" || fiscal.ix_document_type === "invoice_receipt") setDocumentType(fiscal.ix_document_type);
        if (typeof fiscal.ix_exemption_reason === "string" && fiscal.ix_exemption_reason) setExemptionReason(fiscal.ix_exemption_reason);
        if (typeof fiscal.vat_included === "boolean") setVatIncluded(fiscal.vat_included);
        if (typeof fiscal.auto_finalize === "boolean") setAutoFinalize(fiscal.auto_finalize);

        setConnectionActive((source?.connection?.status ?? conn?.status) === "active");
        setSubActive(sub?.ui_state === "active" || sub?.ui_state === "exempt");
    }, []);

    useEffect(() => {
        if (!clerkLoaded) return;
        if (!isSignedIn) { setLoading(false); return; }
        setForm(f => ({ ...f, name: f.name || user?.fullName || "" }));
        load().finally(() => setLoading(false));
    }, [clerkLoaded, isSignedIn, user, load]);

    // Whatever the Stripe callback came back with, shown inside its own step.
    useEffect(() => {
        const detail = params.get("detail");
        const stripeResult = params.get("stripe");
        if (stripeResult === "denied") setStripeError(tWiz("stripeDenied"));
        else if (stripeResult === "error") setStripeError(detail || tWiz("stripeFailed"));
    }, [params, tWiz]);

    const done: Record<StepId, boolean> = {
        account: !!isSignedIn,
        company: profileDone,
        stripe: stripeConnected,
        ix: ixSaved,
        settings: connectionActive,
        subscribe: subActive,
    };
    const doneCount = STEP_IDS.filter(id => done[id]).length;
    const firstOpenIndex = STEP_IDS.findIndex(id => !done[id]);
    const currentIndex = firstOpenIndex === -1 ? STEP_IDS.length - 1 : firstOpenIndex;
    const activeStep = openStep ?? STEP_IDS[currentIndex];
    const allDone = doneCount === STEP_IDS.length;

    /** A company NIF starts with 5, 6, 8 or 9; only then is a legal name asked for. */
    const isCompany = ["5", "6", "8", "9"].includes(form.nif.trim()[0] ?? "");

    const ixHref = ixSubdomain(ixAccount)
        ? `https://${ixSubdomain(ixAccount)}.app.invoicexpress.com/users/account`
        : "https://web.invoicexpress.com/users/sign_in";

    const saveProfile = async (e: React.FormEvent) => {
        e.preventDefault();
        setSavingProfile(true);
        setProfileError("");
        const body = JSON.stringify({
            ...form,
            email: user?.primaryEmailAddress?.emailAddress ?? "",
        });
        const post = () => fetch("/api/user/profile", {
            method: "POST", headers: { "Content-Type": "application/json" }, body,
        });
        try {
            let res = await post();
            // 409 is "no users row yet": the sync on load lost the race with a
            // sign-up that had only just finished. Sync again and retry once.
            if (res.status === 409) {
                await fetch("/api/auth/sync", { method: "POST" }).catch(() => {});
                res = await post();
            }
            if (!res.ok) {
                setProfileError(tReg("saveError"));
                return;
            }
            setProfileDone(true);
            setOpenStep("stripe");
        } catch {
            setProfileError(tReg("saveError"));
        } finally {
            setSavingProfile(false);
        }
    };

    const connectStripe = async () => {
        setBusy("stripe");
        setStripeError("");
        try {
            const res = await fetch("/api/integrations/stripe-connect/start", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    destination_kind: DESTINATION_KIND,
                    // So the callback brings them back here, and not to the wizard.
                    return_slug: RETURN_SLUG_ONBOARDING_CONNECT_IX,
                    return_locale: locale,
                }),
            });
            const json: any = await res.json();
            if (!res.ok || !json.authorize_url) {
                setStripeError(json.error ?? `HTTP ${res.status}`);
                return;
            }
            // Full-page navigation on purpose: the consent screen is where the
            // merchant picks an account, and it has to be unmistakably Stripe's.
            window.location.href = json.authorize_url;
        } catch (e: any) {
            setStripeError(e?.message ?? "Unknown error");
        } finally {
            setBusy(null);
        }
    };

    /**
     * Save the credentials, then make InvoiceXpress answer with them.
     *
     * The verification is the point of the step. A key with a stray space, a key
     * from the sandbox account, an account name that is really the full address:
     * all of them save without complaint and only surface days later, as
     * documents that were never issued.
     */
    const saveIx = async () => {
        const account = ixSubdomain(ixAccount);
        if (!account || !ixApiKey.trim()) return;
        setBusy("ix");
        setIxError("");
        setIxVerified(false);
        try {
            const credsRes = await fetch("/api/integrations", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    ix_account_name: account,
                    ix_api_key: ixApiKey.trim(),
                    ix_environment: "production",
                }),
            });
            if (!credsRes.ok) {
                const d: any = await credsRes.json().catch(() => ({}));
                setIxError(d.error ?? tIx("errorSaveCreds"));
                return;
            }
            setIxAccount(account);
            setIxSaved(true);

            const check = await fetch("/api/integrations/validate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ type: "ix" }),
            });
            // `isValid`, not `valid`: the endpoint answers 200 with the verdict
            // in the body, and reading `res.ok` alone calls a rejected key good.
            const verdict: any = await check.json().catch(() => ({}));
            if (!check.ok || !verdict?.isValid) {
                setIxError(verdict?.error || verdict?.message || t("ix.verifyFailed"));
                return;
            }
            setIxVerified(true);
            setOpenStep("settings");
        } catch (e: any) {
            setIxError(e?.message ?? "Unknown error");
        } finally {
            setBusy(null);
        }
    };

    const saveSettings = async () => {
        setBusy("settings");
        setSettingsError("");
        try {
            const res = await fetch("/api/integrations/stripe-source", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    source_kind: SOURCE_KIND,
                    destination_kind: DESTINATION_KIND,
                    fiscal: {
                        ix_sequence_name: sequenceName.trim(),
                        ix_document_type: documentType,
                        ix_exemption_reason: exemptionReason,
                        vat_included: vatIncluded,
                        auto_finalize: autoFinalize,
                    },
                    status: "active",
                }),
            });
            if (!res.ok) {
                const json: any = await res.json().catch(() => ({}));
                setSettingsError(json.error ?? tIx("errorActivate"));
                return;
            }
            setConnectionActive(true);
            setOpenStep("subscribe");
        } catch (e: any) {
            setSettingsError(e?.message ?? "Unknown error");
        } finally {
            setBusy(null);
        }
    };

    const authHref = (page: "sign-up" | "sign-in") =>
        `/${locale}/${page}?onboarding=${RETURN_SLUG_ONBOARDING_CONNECT_IX}`;

    const bodies: Record<StepId, React.ReactNode> = {
        account: isSignedIn ? (
            <div className="space-y-5">
                <Notice tone="good">
                    <p className="font-medium text-fg">{t("account.signedInAs", { email: user?.primaryEmailAddress?.emailAddress ?? "" })}</p>
                    <p>{t("account.signedInBody")}</p>
                </Notice>
                <PrimaryButton onClick={() => setOpenStep("company")}>
                    {t("continue")} <ArrowRight className="w-4 h-4" />
                </PrimaryButton>
                {/* The way out of the wrong account. Everything on this page is
                    written against whoever is signed in, so a merchant who
                    arrived with another email — a personal one, a colleague's
                    session on a shared browser — has no other way back. */}
                <button
                    type="button"
                    onClick={() => signOut({ redirectUrl: window.location.pathname })}
                    className="w-full py-3.5 rounded-2xl border border-hairline text-fg-60 font-mono text-[10px] uppercase tracking-[0.18em] flex items-center justify-center gap-2 transition-colors hover:border-rule hover:text-fg"
                >
                    <LogOut className="w-3.5 h-3.5" /> {t("account.signOut")}
                </button>
            </div>
        ) : (
            <div className="space-y-5">
                <Notice tone="info"><p>{t("account.body")}</p></Notice>
                <a
                    href={authHref("sign-up")}
                    className="w-full py-4 rounded-2xl bg-fg text-surface font-mono text-xs uppercase tracking-[0.18em] flex items-center justify-center gap-3 transition-all duration-300 transform active:scale-[0.98] hover:bg-accent-hot shadow-[0_8px_30px_-12px_color-mix(in_srgb,var(--accent)_45%,transparent)]"
                >
                    <UserPlus className="w-4 h-4" /> {t("account.create")}
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
            <form onSubmit={saveProfile} className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="md:col-span-2">
                    <Notice tone="info"><p>{t("company.body")}</p></Notice>
                </div>

                <div className="md:col-span-2">
                    <Field label={tReg("nifLabel")}>
                        <div className="relative">
                            <ShieldCheck className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-40" />
                            <input
                                required inputMode="numeric" maxLength={9} placeholder={tReg("nifPlaceholder")}
                                className={cn(INPUT_CLASS, "pl-14 font-mono")}
                                value={form.nif}
                                onChange={e => setForm({ ...form, nif: e.target.value.replace(/\D/g, "") })}
                            />
                        </div>
                    </Field>
                </div>

                <div className="md:col-span-2">
                    <Field label={isCompany ? tReg("companyNameLabel") : tReg("personNameLabel")}>
                        <div className="relative">
                            {isCompany
                                ? <Building2 className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-40" />
                                : <User className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-40" />}
                            <input
                                required
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
                    <Field label={tReg("addressLabel")}>
                        <div className="relative">
                            <MapPin className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-40" />
                            <input
                                required placeholder={tReg("addressPlaceholder")}
                                className={cn(INPUT_CLASS, "pl-14")}
                                value={form.fiscal_address}
                                onChange={e => setForm({ ...form, fiscal_address: e.target.value })}
                            />
                        </div>
                    </Field>
                </div>

                <Field label={tReg("phoneLabel")}>
                    <div className="relative">
                        <Phone className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-40" />
                        <input
                            type="tel" className={cn(INPUT_CLASS, "pl-14")}
                            value={form.phone}
                            onChange={e => setForm({ ...form, phone: e.target.value })}
                        />
                    </div>
                </Field>

                <Field label={tReg("websiteLabel")}>
                    <div className="relative">
                        <Globe className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-40" />
                        <input
                            type="url" placeholder={tReg("websitePlaceholder")}
                            className={cn(INPUT_CLASS, "pl-14")}
                            value={form.website}
                            onChange={e => setForm({ ...form, website: e.target.value })}
                        />
                    </div>
                </Field>

                <label className="md:col-span-2 flex items-center gap-3 cursor-pointer group">
                    <input
                        required type="checkbox" className="peer sr-only"
                        checked={form.privacy_policy_accepted}
                        onChange={e => setForm({ ...form, privacy_policy_accepted: e.target.checked })}
                    />
                    <span className="w-6 h-6 rounded-lg border-2 border-hairline bg-surface-2 flex items-center justify-center transition-all group-hover:border-accent/50 peer-checked:bg-accent peer-checked:border-accent">
                        <Check className="w-3.5 h-3.5 text-on-accent opacity-0 peer-checked:opacity-100 transition-opacity" />
                    </span>
                    <span className="text-[13px] font-medium text-fg-60 group-hover:text-fg transition-colors">
                        {tReg("privacyAccept")}{" "}
                        <Link href="/privacy" className="text-accent-ink hover:text-accent-hover transition-colors">
                            {t("company.privacyLink")}
                        </Link>
                    </span>
                </label>

                {profileError && (
                    <div className="md:col-span-2"><Notice tone="bad"><p>{profileError}</p></Notice></div>
                )}

                <div className="md:col-span-2">
                    <PrimaryButton type="submit" busy={savingProfile}>
                        {profileDone ? t("company.update") : tReg("submit")} <ArrowRight className="w-4 h-4" />
                    </PrimaryButton>
                </div>
            </form>
        ),

        stripe: (
            <div className="space-y-5">
                <Notice tone="info">
                    <p className="font-medium text-fg">{tWiz("stripeIntroTitle")}</p>
                    <p>{tWiz("stripeIntroBody")}</p>
                    <p className="text-fg-40">{tWiz("stripeScopeNote")}</p>
                </Notice>

                {stripeError && <Notice tone="bad"><p>{stripeError}</p></Notice>}

                {stripeConnected ? (
                    <>
                        <Notice tone="good">
                            <p className="font-medium text-fg">{tWiz("stripeConnected")}</p>
                            <p className="font-mono text-[11px] text-fg-40 break-all">{stripeAccountId}</p>
                        </Notice>
                        <PrimaryButton onClick={() => setOpenStep("ix")}>
                            {t("ix.continueTo")} <ArrowRight className="w-4 h-4" />
                        </PrimaryButton>
                    </>
                ) : (
                    <PrimaryButton onClick={connectStripe} busy={busy === "stripe"}>
                        {t("stripe.connectWith")}
                        <Image src="/images/stripe-logo.svg" alt="Stripe" width={44} height={18} className="h-4 w-auto" />
                    </PrimaryButton>
                )}
            </div>
        ),

        ix: (
            <div className="space-y-6">
                <Notice tone="info">
                    <p className="font-medium text-fg">{t("ix.introTitle")}</p>
                    <ol className="list-decimal pl-4 space-y-1.5 mt-1.5">
                        {/* The word "InvoiceXpress" carries the link, as "Moloni"
                            does on the sibling page. It opens their own sign-in,
                            or the API page of the account already typed. */}
                        <li>
                            {t.rich("ix.step1", {
                                link: chunks => (
                                    <a
                                        href={ixHref}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-accent-ink font-medium underline underline-offset-2 hover:text-accent-hover transition-colors"
                                    >
                                        {chunks}
                                    </a>
                                ),
                            })}
                        </li>
                        <li>{t("ix.step2")}</li>
                        <li>{t("ix.step3")}</li>
                    </ol>
                </Notice>

                <div className="grid md:grid-cols-2 gap-6">
                    <Field label={tIx("fieldIxAccountLabel")} hint={t("ix.accountHint")}>
                        <input
                            className={cn(INPUT_CLASS, "font-mono")} placeholder={tIx("fieldIxAccountPlaceholder")}
                            value={ixAccount}
                            onChange={e => { setIxAccount(e.target.value); setIxVerified(false); }}
                        />
                    </Field>
                    <Field label={tIx("fieldIxApiKeyLabel")} hint={t("ix.apiKeyHint")}>
                        <input
                            type="password" className={cn(INPUT_CLASS, "font-mono")}
                            placeholder={tIx("fieldIxApiKeyPlaceholder")}
                            value={ixApiKey}
                            onChange={e => { setIxApiKey(e.target.value); setIxVerified(false); }}
                        />
                    </Field>
                </div>

                {ixError && <Notice tone="bad"><p>{ixError}</p></Notice>}
                {ixVerified && (
                    <Notice tone="good">
                        <p className="font-medium text-fg">{t("ix.verified")}</p>
                        <p>{t("ix.verifiedBody")}</p>
                    </Notice>
                )}

                <div className="space-y-3">
                    <PrimaryButton onClick={saveIx} busy={busy === "ix"} disabled={!ixAccount.trim() || !ixApiKey.trim()}>
                        {t("ix.save")} <ArrowRight className="w-4 h-4" />
                    </PrimaryButton>
                    {ixSaved && (
                        <button
                            onClick={() => setOpenStep("settings")}
                            className="w-full py-4 rounded-2xl border border-hairline font-mono text-[10px] uppercase tracking-[0.18em] transition-colors hover:border-rule"
                        >
                            {t("settings.continueTo")}
                        </button>
                    )}
                </div>
            </div>
        ),

        settings: (
            <div className="space-y-6">
                <Notice tone="info"><p>{t("settings.body")}</p></Notice>

                <Field label={tIx("fieldSeqLabel")} hint={t("settings.sequenceHint")}>
                    <input
                        className={INPUT_CLASS} placeholder={tIx("fieldSeqPlaceholder")}
                        value={sequenceName} onChange={e => setSequenceName(e.target.value)}
                    />
                </Field>

                <div className="space-y-2.5">
                    <Eyebrow>{tIx("docType")}</Eyebrow>
                    <div className="flex gap-2">
                        {(["invoice_receipt", "invoice"] as const).map(dt => (
                            <button
                                key={dt} onClick={() => setDocumentType(dt)}
                                className={cn(
                                    "flex-1 rounded-xl py-3.5 font-mono text-[10px] uppercase tracking-[0.18em] transition-all duration-300",
                                    documentType === dt
                                        ? "bg-accent-hot text-surface"
                                        : "bg-surface-2/50 text-fg-40 ring-1 ring-inset ring-hairline hover:text-fg",
                                )}
                            >
                                {dt === "invoice" ? tIx("docTypeInvoice") : tIx("docTypeReceipt")}
                            </button>
                        ))}
                    </div>
                    <p className="text-[11px] text-fg-40 ml-1">{t("settings.documentTypeHint")}</p>
                </div>

                <div className="grid md:grid-cols-2 gap-4">
                    <Switch
                        checked={vatIncluded} onChange={setVatIncluded}
                        label={tIx("vatIncluded")}
                        hint={vatIncluded ? tIx("vatIncludedOn") : tIx("vatIncludedOff")}
                    />
                    <Switch
                        checked={autoFinalize} onChange={setAutoFinalize}
                        label={tIx("autoFinalize")} hint={tIx("autoFinalizeDesc")}
                    />
                </div>

                <Field label={tIx("exemptionTitle")} hint={t("settings.exemptionHint")}>
                    <select className={INPUT_CLASS} value={exemptionReason} onChange={e => setExemptionReason(e.target.value)}>
                        {VAT_EXEMPTION_OPTIONS.map(o => (
                            <option key={o.value} value={o.value}>{o.value} · {o.label}</option>
                        ))}
                    </select>
                </Field>

                {settingsError && <Notice tone="bad"><p>{settingsError}</p></Notice>}

                <PrimaryButton onClick={saveSettings} busy={busy === "settings"}>
                    {t("settings.finish")} <ArrowRight className="w-4 h-4" />
                </PrimaryButton>
            </div>
        ),

        subscribe: subActive ? (
            // Nothing to pay: an account that is already subscribed must not be
            // handed a payment form that would open a second subscription.
            <Notice tone="good">
                <p className="font-medium text-fg">{tSub("doneTitle")}</p>
                <p>{tSub("doneBody")}</p>
            </Notice>
        ) : (
            <div className="space-y-5">
                <Notice tone="info"><p>{t("subscribe.body")}</p></Notice>
                <OnboardingSubscribe
                    source="stripe-connect-ix"
                    connectionKey={CONNECTION_KEY}
                    returnSlug={RETURN_SLUG_ONBOARDING_CONNECT_IX}
                    onSubscribed={() => setSubActive(true)}
                />
                <p className="text-[11px] leading-relaxed text-fg-40">{t("subscribe.note")}</p>
            </div>
        ),
    };

    const stepIcon: Record<StepId, typeof UserPlus> = {
        account: UserPlus, company: Building2, stripe: CreditCard,
        ix: ShieldCheck, settings: Settings2, subscribe: Sparkles,
    };

    if (!clerkLoaded || loading) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <Loader2 className="w-10 h-10 animate-spin text-accent-ink opacity-50" />
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
                            Stripe · InvoiceXpress
                        </span>
                    </div>
                    <div className="flex items-center gap-1.5 sm:gap-2">
                        {/* The way out of the wrong account, from anywhere on
                            the page. It also lives inside step one, but that step
                            collapses the moment it is done, and a merchant who
                            signed up with the wrong email notices later. */}
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
                        transition={{ duration: 0.6, ease: [0.32, 0.72, 0, 1] }}
                    />
                </div>
            </header>

            <main className="mx-auto max-w-3xl px-5 sm:px-8 pb-24">
                <section className="pt-14 sm:pt-20 pb-10 space-y-5">
                    <span className="inline-flex items-center gap-2 rounded-full border border-accent/20 bg-accent/10 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.22em] text-accent-ink">
                        <Sparkles className="w-3 h-3" /> {t("eyebrow")}
                    </span>
                    <h1 className="text-[2rem] sm:text-5xl font-medium tracking-tight leading-[1.05]">{t("title")}</h1>
                    <p className="text-base sm:text-lg text-fg-60 leading-relaxed max-w-2xl">{t("subtitle")}</p>
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                        {["trust1", "trust2", "trust3"].map(k => (
                            <span key={k} className="inline-flex items-center gap-2 rounded-full border border-hairline bg-veil px-3 py-1.5 text-[11px] font-medium text-fg-60">
                                <Check className="w-3 h-3 text-accent-hot" /> {t(k)}
                            </span>
                        ))}
                    </div>
                    <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-fg-40 pt-2">
                        {allDone ? t("allDone") : t("progress", { current: currentIndex + 1, total: STEP_IDS.length })}
                    </p>
                </section>

                {allDone && (
                    <motion.div
                        initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
                        className="glass rounded-[2rem] border-accent-hot/30 bg-accent-hot/5 p-6 sm:p-8 mb-8 flex flex-col sm:flex-row sm:items-center gap-5"
                    >
                        <span className="w-12 h-12 rounded-2xl bg-accent-hot/15 ring-1 ring-accent-hot/30 flex items-center justify-center shrink-0">
                            <Check className="w-6 h-6 text-accent-hot" />
                        </span>
                        <div className="flex-1 space-y-1">
                            <h2 className="text-xl font-medium tracking-tight">{t("finished.title")}</h2>
                            <p className="text-[13px] text-fg-60 leading-relaxed">{t("finished.body")}</p>
                        </div>
                        <Link
                            href="/dashboard"
                            className="shrink-0 rounded-2xl bg-fg px-6 py-3.5 font-mono text-[10px] uppercase tracking-[0.18em] text-surface flex items-center justify-center gap-2 transition-all hover:bg-accent-hot"
                        >
                            {t("finished.cta")} <ArrowRight className="w-3.5 h-3.5" />
                        </Link>
                    </motion.div>
                )}

                <div className="space-y-4">
                    {STEP_IDS.map((id, index) => {
                        const Icon = stepIcon[id];
                        const isDone = done[id];
                        const isLocked = index > currentIndex;
                        const isOpen = activeStep === id && !isLocked;
                        return (
                            <motion.section
                                key={id}
                                layout
                                transition={{ duration: 0.4, ease: [0.32, 0.72, 0, 1] }}
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
                                        {isDone ? <Check className="w-5 h-5" /> : isLocked ? <Lock className="w-4 h-4" /> : <Icon className="w-5 h-5" />}
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

                                    <ChevronDown className={cn("w-4 h-4 shrink-0 text-fg-40 transition-transform duration-300", isOpen && "rotate-180")} />
                                </button>

                                <AnimatePresence initial={false}>
                                    {isOpen && (
                                        <motion.div
                                            key="body"
                                            initial={{ height: 0, opacity: 0 }}
                                            animate={{ height: "auto", opacity: 1 }}
                                            exit={{ height: 0, opacity: 0 }}
                                            transition={{ duration: 0.35, ease: [0.32, 0.72, 0, 1] }}
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
