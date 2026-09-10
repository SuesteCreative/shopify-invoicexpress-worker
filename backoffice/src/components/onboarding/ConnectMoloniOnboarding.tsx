"use client";

import { useCallback, useEffect, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { AnimatePresence, motion } from "framer-motion";
import Image from "next/image";
import {
    AlertTriangle, ArrowRight, Building2, Check, ChevronDown, Copy, CreditCard,
    Globe, Loader2, Lock, MapPin, Phone, Settings2, ShieldCheck, Sparkles, User,
    UserPlus,
} from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { Link } from "@/i18n/navigation";
import SubscriptionCard from "@/components/SubscriptionCard";
import { ThemedLogo } from "@/components/ThemedLogo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LangToggle } from "@/components/landing/LangToggle";
import { RETURN_SLUG_ONBOARDING_CONNECT_MOLONI } from "@/lib/oauth-return";

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

/**
 * The client-facing onboarding for Stripe Connect → Moloni.
 *
 * The same six things the dashboard wizard does, on one public page a merchant
 * can be sent a link to before they have an account: sign up, company details,
 * authorise Stripe, authorise Moloni, invoicing settings, subscribe. Every step
 * calls the endpoint that already exists, so nothing here is a second
 * implementation of the flow, only a second way in.
 *
 * Each step reads its state back from the server rather than trusting where the
 * merchant thinks they are: both OAuth steps leave the site entirely, and a flow
 * that resumed from local state would resume in the wrong place.
 */

const SOURCE_KIND = "stripe_connect";
const CONNECTION_KEY = "stripe_connect:moloni";
const SUPPORT_EMAIL = "rioko@kapta.pt";

/** The same list the dashboard wizards carry. Only reached when a line is 0%. */
const EXEMPTION_OPTIONS = [
    { value: "M01", label: "Artigo 16.º, n.º 6 do CIVA" },
    { value: "M02", label: "Artigo 6.º do Decreto-Lei n.º 198/90, de 19 de junho" },
    { value: "M04", label: "Isento artigo 13.º do CIVA" },
    { value: "M05", label: "Isento artigo 14.º do CIVA" },
    { value: "M06", label: "Isento artigo 15.º do CIVA" },
    { value: "M07", label: "Isento artigo 9.º do CIVA" },
    { value: "M09", label: "IVA – não confere direito a dedução" },
    { value: "M10", label: "Regime especial de isenção artigo 53.º do CIVA" },
    { value: "M11", label: "Regime particular do tabaco" },
    { value: "M16", label: "Isento artigo 14.º do RITI" },
    { value: "M20", label: "IVA - regime forfetário" },
    { value: "M99", label: "Não sujeito; não tributado (ou similar)" },
];

type StepId = "account" | "company" | "stripe" | "moloni" | "settings" | "subscribe";
const STEP_IDS: StepId[] = ["account", "company", "stripe", "moloni", "settings", "subscribe"];

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

export default function ConnectMoloniOnboarding() {
    const t = useTranslations("connectOnboarding");
    const tReg = useTranslations("registrationForm");
    const tWiz = useTranslations("stripeConnectMoloniSetup");
    const tSet = useTranslations("stripeMoloniSetup");
    const locale = useLocale();
    const { isLoaded: clerkLoaded, isSignedIn, user } = useUser();
    const params = useSearchParams();

    const [loading, setLoading] = useState(true);
    const [openStep, setOpenStep] = useState<StepId | null>(null);

    // Server-side truth for every step.
    const [profileDone, setProfileDone] = useState(false);
    const [connectionId, setConnectionId] = useState("");
    const [stripeConnected, setStripeConnected] = useState(false);
    const [stripeAccountId, setStripeAccountId] = useState("");
    const [moloniAuthorized, setMoloniAuthorized] = useState(false);
    const [connectionActive, setConnectionActive] = useState(false);
    const [subActive, setSubActive] = useState(false);

    // Step 2 — the company details, written to the profile the dashboard reads.
    const [form, setForm] = useState({
        nif: "", name: "", company_name: "", fiscal_address: "", phone: "", website: "",
        privacy_policy_accepted: false,
    });
    const [savingProfile, setSavingProfile] = useState(false);
    const [profileError, setProfileError] = useState("");

    // Step 4 — the merchant's own Moloni developer app.
    const [clientId, setClientId] = useState("");
    const [clientSecret, setClientSecret] = useState("");
    const [environment, setEnvironment] = useState<"production" | "sandbox">("production");
    const [copied, setCopied] = useState(false);

    // Step 5 — invoicing settings.
    const [companyName, setCompanyName] = useState("");
    const [documentSetName, setDocumentSetName] = useState("");
    const [documentType, setDocumentType] = useState<"invoice" | "invoice_receipt">("invoice_receipt");
    const [vatIncluded, setVatIncluded] = useState(true);
    const [autoFinalize, setAutoFinalize] = useState(false);
    const [sendEmail, setSendEmail] = useState(false);
    const [defaultVatRate, setDefaultVatRate] = useState("");
    const [exemptionReason, setExemptionReason] = useState("M01");

    const [busy, setBusy] = useState<"stripe" | "moloni" | "settings" | null>(null);
    const [stripeError, setStripeError] = useState("");
    const [moloniError, setMoloniError] = useState("");
    const [settingsError, setSettingsError] = useState("");

    const load = useCallback(async () => {
        // This call is what creates the users row, and the profile write needs it
        // to exist: a sign-up whose Clerk webhook has not landed yet has no row.
        await fetch("/api/auth/sync", { method: "POST" }).catch(() => {});

        const [profile, connect, moloni, sub] = await Promise.all([
            fetch("/api/user/profile").then(r => (r.ok ? r.json() : null)).catch(() => null),
            fetch("/api/integrations/stripe-connect").then(r => r.json()).catch(() => ({})),
            fetch(`/api/integrations/moloni-destination?source_kind=${SOURCE_KIND}`).then(r => r.json()).catch(() => ({})),
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
        setConnectionId(conn?.id ?? "");
        setStripeConnected(!!conn?.stripe?.connected);
        setStripeAccountId(conn?.stripe?.stripe_account_id ?? "");
        setMoloniAuthorized(!!conn?.moloni?.authorized);
        if (conn?.moloni?.error) setMoloniError(String(conn.moloni.error));

        const cfg = moloni?.connection?.destination_config ?? {};
        if (cfg.moloni_client_id) setClientId(String(cfg.moloni_client_id));
        if (cfg.moloni_company_name) setCompanyName(String(cfg.moloni_company_name));
        if (cfg.moloni_document_set_name) setDocumentSetName(String(cfg.moloni_document_set_name));
        if (cfg.moloni_environment === "sandbox" || cfg.moloni_environment === "production") setEnvironment(cfg.moloni_environment);
        if (cfg.moloni_document_type === "invoice" || cfg.moloni_document_type === "invoice_receipt") setDocumentType(cfg.moloni_document_type);
        if (typeof cfg.vat_included === "boolean") setVatIncluded(cfg.vat_included);
        if (typeof cfg.auto_finalize === "boolean") setAutoFinalize(cfg.auto_finalize);
        if (typeof cfg.send_email === "boolean") setSendEmail(cfg.send_email);
        if (cfg.default_vat_rate != null) setDefaultVatRate(String(cfg.default_vat_rate));
        if (typeof cfg.exemption_reason === "string") setExemptionReason(cfg.exemption_reason);

        setConnectionActive((conn?.status ?? moloni?.connection?.status) === "active");
        setSubActive(sub?.ui_state === "active" || sub?.ui_state === "exempt");
    }, []);

    useEffect(() => {
        if (!clerkLoaded) return;
        if (!isSignedIn) { setLoading(false); return; }
        setForm(f => ({ ...f, name: f.name || user?.fullName || "" }));
        load().finally(() => setLoading(false));
    }, [clerkLoaded, isSignedIn, user, load]);

    // Whatever the OAuth callbacks came back with, shown inside its own step.
    useEffect(() => {
        const detail = params.get("detail");
        const stripeResult = params.get("stripe");
        const moloniResult = params.get("moloni");
        if (stripeResult === "denied") setStripeError(tWiz("stripeDenied"));
        else if (stripeResult === "error") setStripeError(detail || tWiz("stripeFailed"));
        if (moloniResult === "denied") setMoloniError(tWiz("moloniDenied"));
        else if (moloniResult === "error") setMoloniError(detail || tWiz("moloniFailed"));
    }, [params, tWiz]);

    const done: Record<StepId, boolean> = {
        account: !!isSignedIn,
        company: profileDone,
        stripe: stripeConnected,
        moloni: moloniAuthorized,
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

    const redirectUri = connectionId
        ? `${typeof window !== "undefined" ? window.location.origin : "https://rioko.online"}/api/integrations/moloni-oauth/callback/${connectionId}`
        : "";

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
                    destination_kind: "moloni",
                    // So the callback brings them back here, and not to the wizard.
                    return_slug: RETURN_SLUG_ONBOARDING_CONNECT_MOLONI,
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

    const authorizeMoloni = async () => {
        setBusy("moloni");
        setMoloniError("");
        try {
            const res = await fetch("/api/integrations/moloni-oauth/start", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    client_id: clientId.trim(),
                    client_secret: clientSecret.trim() || undefined,
                    environment,
                }),
            });
            const json: any = await res.json();
            if (!res.ok || !json.authorize_url) {
                setMoloniError(json.error ?? `HTTP ${res.status}`);
                return;
            }
            window.location.href = json.authorize_url;
        } catch (e: any) {
            setMoloniError(e?.message ?? "Unknown error");
        } finally {
            setBusy(null);
        }
    };

    const saveSettings = async () => {
        if (!companyName.trim()) {
            setSettingsError(tSet("errorSettingsRequired"));
            return;
        }
        setBusy("settings");
        setSettingsError("");
        try {
            const res = await fetch("/api/integrations/moloni-destination", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    source_kind: SOURCE_KIND,
                    moloni_company_name: companyName.trim(),
                    moloni_document_set_name: documentSetName.trim(),
                    moloni_document_type: documentType,
                    moloni_environment: environment,
                    vat_included: vatIncluded,
                    auto_finalize: autoFinalize,
                    send_email: sendEmail,
                    exemption_reason: exemptionReason,
                    default_vat_rate: defaultVatRate.trim() === "" ? null : Number(defaultVatRate),
                    status: "active",
                }),
            });
            if (!res.ok) {
                const json: any = await res.json().catch(() => ({}));
                setSettingsError(json.error ?? tSet("errorActivate"));
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

    const copyRedirectUri = async () => {
        try {
            await navigator.clipboard.writeText(redirectUri);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch { /* clipboard blocked; the field is selectable anyway */ }
    };

    const authHref = (page: "sign-up" | "sign-in") =>
        `/${locale}/${page}?onboarding=${RETURN_SLUG_ONBOARDING_CONNECT_MOLONI}`;

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
                        <PrimaryButton onClick={() => setOpenStep("moloni")}>
                            {tWiz("continueToMoloni")} <ArrowRight className="w-4 h-4" />
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

        moloni: (
            <div className="space-y-6">
                <Notice tone="info">
                    <p className="font-medium text-fg">{tWiz("moloniIntroTitle")}</p>
                    <ol className="list-decimal pl-4 space-y-1.5 mt-1.5">
                        {/* Same instruction as the wizard's, with the word "Moloni"
                            carrying the link to their customer area, which is where
                            the API is switched on. */}
                        <li>
                            {t.rich("moloni.step1", {
                                link: chunks => (
                                    <a
                                        href="https://www.moloni.pt/ac/"
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-accent-ink font-medium underline underline-offset-2 hover:text-accent-hover transition-colors"
                                    >
                                        {chunks}
                                    </a>
                                ),
                            })}
                        </li>
                        <li>{tWiz("moloniStep2")}</li>
                        <li>{tWiz("moloniStep3")}</li>
                    </ol>
                </Notice>

                <div className="rounded-2xl border border-hairline bg-surface-2/40 p-5 space-y-3">
                    <p className="text-sm font-medium text-fg">{tWiz("redirectUriTitle")}</p>
                    <p className="text-[11px] leading-relaxed text-fg-40">{tWiz("redirectUriBody")}</p>
                    <div className="flex flex-col sm:flex-row items-stretch gap-3">
                        <code className="flex-1 min-w-0 rounded-xl border border-hairline bg-surface-2/60 px-4 py-3 font-mono text-[11px] break-all">
                            {redirectUri || tWiz("redirectUriPending")}
                        </code>
                        <button
                            onClick={copyRedirectUri} disabled={!redirectUri}
                            className="shrink-0 rounded-xl border border-hairline px-4 py-3 font-mono text-[10px] uppercase tracking-[0.18em] flex items-center justify-center gap-2 transition-colors hover:border-rule disabled:opacity-30"
                        >
                            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                            {copied ? tWiz("copied") : tWiz("copy")}
                        </button>
                    </div>
                </div>

                <div className="grid md:grid-cols-2 gap-6">
                    <Field label={tWiz("developerIdLabel")} hint={tSet("clientIdHint")}>
                        <input
                            className={cn(INPUT_CLASS, "font-mono")} placeholder={tSet("clientIdPlaceholder")}
                            value={clientId} onChange={e => setClientId(e.target.value)}
                        />
                    </Field>
                    <Field
                        label={tWiz("clientSecretLabel")}
                        hint={moloniAuthorized ? tSet("secretStoredHint") : tSet("clientSecretHint")}
                    >
                        <input
                            type="password" className={cn(INPUT_CLASS, "font-mono")}
                            placeholder={moloniAuthorized ? "••••••••" : ""}
                            value={clientSecret} onChange={e => setClientSecret(e.target.value)}
                        />
                    </Field>
                </div>

                <div className="space-y-2.5">
                    <Eyebrow>{tWiz("environmentLabel")}</Eyebrow>
                    <div className="flex gap-2">
                        {(["production", "sandbox"] as const).map(env => (
                            <button
                                key={env} onClick={() => setEnvironment(env)}
                                className={cn(
                                    "flex-1 rounded-xl py-3.5 font-mono text-[10px] uppercase tracking-[0.18em] transition-all duration-300",
                                    environment === env
                                        ? "bg-accent-hot text-surface"
                                        : "bg-surface-2/50 text-fg-40 ring-1 ring-inset ring-hairline hover:text-fg",
                                )}
                            >
                                {env === "production" ? tWiz("envProduction") : tWiz("envSandbox")}
                            </button>
                        ))}
                    </div>
                    <p className="text-[11px] text-fg-40 ml-1">{tSet("environmentHint")}</p>
                </div>

                {moloniError && <Notice tone="bad"><p>{moloniError}</p></Notice>}
                {moloniAuthorized && (
                    <Notice tone="good">
                        <p className="font-medium text-fg">{tWiz("moloniAuthorized")}</p>
                        <p>{t("moloni.authorizedBody")}</p>
                    </Notice>
                )}

                <div className="space-y-3">
                    <PrimaryButton onClick={authorizeMoloni} busy={busy === "moloni"} disabled={!clientId.trim()}>
                        {moloniAuthorized ? tWiz("reauthorizeMoloni") : tWiz("authorizeMoloni")}
                        <ArrowRight className="w-4 h-4" />
                    </PrimaryButton>
                    {moloniAuthorized && (
                        <button
                            onClick={() => setOpenStep("settings")}
                            className="w-full py-4 rounded-2xl border border-hairline font-mono text-[10px] uppercase tracking-[0.18em] transition-colors hover:border-rule"
                        >
                            {tWiz("continueToSettings")}
                        </button>
                    )}
                </div>
            </div>
        ),

        settings: (
            <div className="space-y-6">
                <Notice tone="info"><p>{t("settings.body")}</p></Notice>

                <div className="grid md:grid-cols-2 gap-6">
                    <Field label={tSet("companyIdLabel")} hint={tSet("companyNameHint")}>
                        <input className={INPUT_CLASS} value={companyName} onChange={e => setCompanyName(e.target.value)} />
                    </Field>
                    <Field label={tSet("documentSetIdLabel")} hint={tSet("documentSetNameHint")}>
                        <input className={INPUT_CLASS} value={documentSetName} onChange={e => setDocumentSetName(e.target.value)} />
                    </Field>
                </div>

                <div className="space-y-2.5">
                    <Eyebrow>{tSet("documentTypeTitle")}</Eyebrow>
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
                                {dt === "invoice" ? tSet("documentTypeInvoice") : tSet("documentTypeInvoiceReceipt")}
                            </button>
                        ))}
                    </div>
                    <p className="text-[11px] text-fg-40 ml-1">{tSet("documentTypeDesc")}</p>
                </div>

                <div className="grid md:grid-cols-2 gap-4">
                    <Switch
                        checked={vatIncluded} onChange={setVatIncluded}
                        label={tSet("vatIncluded")}
                        hint={vatIncluded ? tSet("vatIncludedOn") : tSet("vatIncludedOff")}
                    />
                    <Switch
                        checked={autoFinalize} onChange={setAutoFinalize}
                        label={tSet("autoFinalize")} hint={tSet("autoFinalizeDesc")}
                    />
                    <Switch
                        checked={sendEmail} onChange={setSendEmail}
                        label={tSet("sendEmail")}
                        hint={!autoFinalize ? tSet("sendEmailNeedsFinalize") : sendEmail ? tSet("sendEmailOn") : tSet("sendEmailOff")}
                    />
                    <Field label={tSet("defaultVatRateLabel")} hint={tSet("defaultVatRateHint")}>
                        <input
                            inputMode="decimal" placeholder="23" className={cn(INPUT_CLASS, "font-mono")}
                            value={defaultVatRate} onChange={e => setDefaultVatRate(e.target.value)}
                        />
                    </Field>
                </div>

                <Field label={tSet("exemptionTitle")} hint={tSet("exemptionDesc")}>
                    <select className={INPUT_CLASS} value={exemptionReason} onChange={e => setExemptionReason(e.target.value)}>
                        {EXEMPTION_OPTIONS.map(o => (
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

        subscribe: (
            <div className="space-y-5">
                <Notice tone="info"><p>{t("subscribe.body")}</p></Notice>
                <SubscriptionCard source="stripe-connect-moloni" connectionKey={CONNECTION_KEY} />
                <p className="text-[11px] leading-relaxed text-fg-40">{t("subscribe.note")}</p>
            </div>
        ),
    };

    const stepIcon: Record<StepId, typeof UserPlus> = {
        account: UserPlus, company: Building2, stripe: CreditCard,
        moloni: ShieldCheck, settings: Settings2, subscribe: Sparkles,
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
                            Stripe · Moloni
                        </span>
                    </div>
                    <div className="flex items-center gap-1.5 sm:gap-2">
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
                    <div className="flex items-center gap-3 text-[11px] text-fg-40 shrink-0">
                        <Link href="/privacy" className="hover:text-fg-60 transition-colors">{t("privacy")}</Link>
                        <span className="text-hairline-strong">·</span>
                        <Link href="/terms" className="hover:text-fg-60 transition-colors">{t("terms")}</Link>
                    </div>
                </footer>
            </main>
        </div>
    );
}
