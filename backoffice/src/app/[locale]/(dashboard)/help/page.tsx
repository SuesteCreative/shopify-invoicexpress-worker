"use client";

import { useState } from "react";
import Image from "next/image";
import { Link } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import {
    ArrowLeft, Mail, BookOpen, Store, Key, Webhook, Globe, FileText,
    Percent, Zap, Tag, Info, X, Search, Settings2, Copy, CreditCard,
    ClipboardList, ChevronDown, Calendar
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

export const runtime = "edge";

// ─── Shared building blocks ───────────────────────────────────────────────

function Section({ id, icon, title, step, children, accent = "rose" }: {
    id: string;
    icon: React.ReactNode;
    title: string;
    step?: string;
    children: React.ReactNode;
    accent?: "rose" | "sky" | "violet" | "emerald" | "amber";
}) {
    const accentText = {
        rose: "text-destructive", sky: "text-accent", violet: "text-accent",
        emerald: "text-accent-hot", amber: "text-soon",
    }[accent];
    return (
        <section id={id} className="scroll-mt-28">
            <div className="flex items-start gap-4 mb-6">
                <div className={`w-12 h-12 rounded-2xl bg-surface-2 border border-hairline flex items-center justify-center shrink-0 ${accentText}`}>
                    {icon}
                </div>
                <div>
                    {step && (
                        <div className="text-[10px] font-black text-fg-40 uppercase tracking-[0.2em] mb-1">{step}</div>
                    )}
                    <h2 className="text-2xl font-black text-white">{title}</h2>
                </div>
            </div>
            <div className="ml-0 sm:ml-16 space-y-6">{children}</div>
        </section>
    );
}

function Steps({ items, accent = "rose" }: { items: string[]; accent?: "rose" | "sky" | "violet" | "emerald" | "amber" }) {
    const pill = {
        rose: "bg-[rgba(244,63,94,0.10)] border-[rgba(244,63,94,0.20)] text-destructive",
        sky: "bg-[rgba(2,141,196,0.10)] border-[rgba(2,141,196,0.20)] text-accent",
        violet: "bg-[rgba(2,141,196,0.10)] border-[rgba(2,141,196,0.20)] text-accent",
        emerald: "bg-[rgba(94,234,212,0.10)] border-[rgba(94,234,212,0.20)] text-accent-hot",
        amber: "bg-[rgba(245,158,11,0.10)] border-[rgba(245,158,11,0.20)] text-soon",
    }[accent];
    return (
        <ol className="space-y-3">
            {items.map((item, i) => (
                <li key={i} className="flex items-start gap-3">
                    <span className={`w-6 h-6 rounded-full border text-[10px] font-black flex items-center justify-center shrink-0 mt-0.5 ${pill}`}>
                        {i + 1}
                    </span>
                    <span className="text-fg text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: item }} />
                </li>
            ))}
        </ol>
    );
}

function Placeholder({ src, alt, description, onZoom }: { src: string; alt: string; description: string; onZoom: (src: string) => void }) {
    const t = useTranslations("help");
    return (
        <div className="rounded-2xl overflow-hidden border border-hairline/60 bg-surface-2/40 cursor-zoom-in group relative" onClick={() => onZoom(src)}>
            <div className="relative w-full aspect-video bg-surface transition-transform duration-500 group-hover:scale-[1.02]">
                <Image src={src} alt={alt} fill className="object-contain p-4" />
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <div className="bg-white/10 backdrop-blur-md p-3 rounded-2xl border border-white/20">
                        <Search className="w-6 h-6 text-white" />
                    </div>
                </div>
                <div className="absolute bottom-3 left-3 right-3 bg-black/70 backdrop-blur-sm rounded-xl px-3 py-2 flex items-center gap-2">
                    <span className="text-soon text-[10px] font-black uppercase tracking-widest">{t("preview")}</span>
                    <span className="text-[11px] text-fg font-medium truncate">{description}</span>
                </div>
            </div>
        </div>
    );
}

function HtmlInfoBox({ html }: { html: string }) {
    return (
        <div className="bg-[rgba(2,141,196,0.05)] border border-[rgba(2,141,196,0.20)] rounded-2xl p-4 flex items-start gap-3">
            <Info className="w-5 h-5 text-accent shrink-0 mt-0.5" />
            <p className="text-accent text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
    );
}

function HtmlWarningBox({ html }: { html: string }) {
    return (
        <div className="bg-[rgba(245,158,11,0.05)] border border-[rgba(245,158,11,0.20)] rounded-2xl p-4">
            <p className="text-soon text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
    );
}

// ─── Contact + Calendly box for steps Kapta runs for you ──────────────────
function ContactBox({ subject = "Rioko - Suporte" }: { subject?: string }) {
    const t = useTranslations("help");
    const mail = `mailto:pedro@kapta.pt?subject=${encodeURIComponent(subject)}`;
    return (
        <div className="bg-[rgba(244,63,94,0.05)] border border-[rgba(244,63,94,0.20)] rounded-2xl p-6 flex flex-col gap-4">
            <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-2xl bg-[rgba(244,63,94,0.10)] border border-[rgba(244,63,94,0.20)] flex items-center justify-center shrink-0">
                    <Mail className="w-5 h-5 text-destructive" />
                </div>
                <div className="flex-1">
                    <p className="text-white font-bold text-sm">{t("thisStepByKapta")}</p>
                    <p className="text-fg-60 text-sm mt-1">
                        {t("thisStepByKaptaBody")}
                    </p>
                </div>
            </div>
            <div className="flex flex-col sm:flex-row gap-2 sm:ml-16">
                <a
                    href="https://calendly.com/pedro-kapta/apoio-kapta"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 bg-accent text-white px-5 py-3 rounded-2xl font-mono text-[11px] uppercase tracking-[0.18em] flex items-center justify-center gap-2 hover:bg-accent/85 transition-all active:scale-95"
                >
                    <Calendar className="w-4 h-4" /> {t("scheduleMeeting")}
                </a>
                <a
                    href={mail}
                    className="flex-1 bg-destructive text-white px-5 py-3 rounded-2xl font-mono text-[11px] uppercase tracking-[0.18em] flex items-center justify-center gap-2 hover:bg-destructive/85 transition-all active:scale-95"
                >
                    <Mail className="w-4 h-4" /> pedro@kapta.pt
                </a>
            </div>
        </div>
    );
}

// ─── Platform tabs ────────────────────────────────────────────────────────

type Platform = "shopify" | "stripe" | "invoicexpress" | "moloni";

type Accent = "emerald" | "violet" | "sky" | "amber";

function usePlatforms() {
    const t = useTranslations("help");
    const PLATFORMS: { id: Platform; label: string; sub: string; icon: React.ComponentType<any>; accent: Accent; group: "payment" | "invoicing" }[] = [
        { id: "shopify", label: "Shopify", sub: t("platformShopifySub"), icon: Store, accent: "emerald", group: "payment" },
        { id: "stripe", label: "Stripe", sub: t("platformStripeSub"), icon: CreditCard, accent: "violet", group: "payment" },
        { id: "invoicexpress", label: "InvoiceXpress", sub: t("platformIxSub"), icon: FileText, accent: "sky", group: "invoicing" },
        { id: "moloni", label: "Moloni", sub: t("platformMoloniSub"), icon: ClipboardList, accent: "amber", group: "invoicing" },
    ];
    return PLATFORMS;
}

const ACCENT_CLASSES: Record<Accent, string> = {
    emerald: "text-accent-hot border-[rgba(94,234,212,0.40)] bg-[rgba(94,234,212,0.10)]",
    violet: "text-accent border-[rgba(2,141,196,0.40)] bg-[rgba(2,141,196,0.10)]",
    sky: "text-accent border-[rgba(2,141,196,0.40)] bg-[rgba(2,141,196,0.10)]",
    amber: "text-soon border-[rgba(245,158,11,0.40)] bg-[rgba(245,158,11,0.10)]",
};

function PlatformTabButton({ p, active, onClick }: { p: ReturnType<typeof usePlatforms>[number]; active: boolean; onClick: () => void }) {
    const Icon = p.icon;
    return (
        <button
            onClick={onClick}
            className={`relative flex items-center gap-3 px-4 py-3 rounded-2xl border transition-all text-left group ${active ? ACCENT_CLASSES[p.accent] : "border-hairline/60 bg-surface-2/40 text-fg-60 hover:border-rule hover:text-fg"}`}
        >
            <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${active ? "bg-white/5" : "bg-surface-2"}`}>
                <Icon className="w-4 h-4" />
            </div>
            <div className="min-w-0">
                <div className="text-sm font-black tracking-tight">{p.label}</div>
                <div className={`text-[10px] uppercase tracking-widest font-bold ${active ? "opacity-80" : "text-fg-40"}`}>{p.sub}</div>
            </div>
        </button>
    );
}

function GroupHeader({ label, gradientFrom, gradientVia }: { label: string; gradientFrom: string; gradientVia: string }) {
    return (
        <div className="flex items-center gap-3 px-1">
            <div className={`h-px flex-1 bg-gradient-to-r ${gradientFrom} ${gradientVia} to-transparent`} />
            <span className="text-[10px] font-black text-fg-40 uppercase tracking-[0.25em] whitespace-nowrap">{label}</span>
            <div className="h-px flex-1" />
        </div>
    );
}

function PlatformTabs({ tab, onChange }: { tab: Platform; onChange: (p: Platform) => void }) {
    const t = useTranslations("help");
    const PLATFORMS = usePlatforms();
    const payment = PLATFORMS.filter(p => p.group === "payment");
    const invoicing = PLATFORMS.filter(p => p.group === "invoicing");
    return (
        <div className="glass rounded-[2rem] p-5 border-hairline space-y-5">
            <div className="space-y-3">
                <GroupHeader label={t("groupPayment")} gradientFrom="from-[rgba(94,234,212,0.30)]" gradientVia="via-[rgba(2,141,196,0.30)]" />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {payment.map(p => (
                        <PlatformTabButton key={p.id} p={p} active={tab === p.id} onClick={() => onChange(p.id)} />
                    ))}
                </div>
            </div>

            <div className="border-t border-hairline" />

            <div className="space-y-3">
                <GroupHeader label={t("groupInvoicing")} gradientFrom="from-[rgba(2,141,196,0.30)]" gradientVia="via-[rgba(245,158,11,0.30)]" />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {invoicing.map(p => (
                        <PlatformTabButton key={p.id} p={p} active={tab === p.id} onClick={() => onChange(p.id)} />
                    ))}
                </div>
            </div>
        </div>
    );
}

// ─── Per-platform guides ──────────────────────────────────────────────────

function ShopifyGuide({ onZoom }: { onZoom: (src: string) => void }) {
    const t = useTranslations("help");
    return (
        <div className="space-y-6">
            <div className="glass rounded-[2rem] p-5 sm:p-8 border-hairline space-y-6">
                <Section id="shopify-domain" icon={<Store className="w-5 h-5" />} title={t("shopifyDomainTitle")} step={t("credentialTotal3")} accent="emerald">
                    <HtmlInfoBox html={t("shopifyDomainInfo")} />
                    <Steps accent="emerald" items={[
                        t("shopifyDomainStep1"),
                        t("shopifyDomainStep2"),
                        t("shopifyDomainStep3"),
                        t("shopifyDomainStep4"),
                    ]} />
                    <Placeholder src="/images/help/shopify-domain.webp" alt="Shopify" description={t("shopifyDomainImageDesc")} onZoom={onZoom} />
                    <HtmlWarningBox html={t("shopifyDomainWarn")} />
                </Section>
            </div>

            <div className="glass rounded-[2rem] p-5 sm:p-8 border-hairline space-y-6">
                <Section id="shopify-token" icon={<Key className="w-5 h-5" />} title={t("shopifyTokenTitle")} step={t("credentialTotal3b")} accent="emerald">
                    <HtmlInfoBox html={t("shopifyTokenInfo")} />
                    <ContactBox subject="Rioko - Access Token Shopify" />
                    <HtmlWarningBox html={t("shopifyTokenWarn")} />
                    <HtmlInfoBox html={t("shopifyTokenOldOrders")} />
                </Section>
            </div>

            <div className="glass rounded-[2rem] p-5 sm:p-8 border-hairline space-y-6">
                <Section id="shopify-webhook" icon={<Webhook className="w-5 h-5" />} title={t("shopifyWebhookTitle")} step={t("credentialTotal3c")} accent="emerald">
                    <HtmlInfoBox html={t("shopifyWebhookInfo")} />
                    <Steps accent="emerald" items={[
                        t("shopifyWebhookStep1"),
                        t("shopifyWebhookStep2"),
                        t("shopifyWebhookStep3"),
                        t("shopifyWebhookStep4"),
                    ]} />
                    <Placeholder src="/images/help/webhook-secret.webp" alt="Shopify - Webhook Signing Secret" description={t("shopifyWebhookImageDesc")} onZoom={onZoom} />
                    <HtmlInfoBox html={t("shopifyWebhookExtra")} />
                </Section>
            </div>

            <div className="glass rounded-[2rem] p-5 sm:p-8 border-hairline space-y-6">
                <Section id="shopify-api-version" icon={<Globe className="w-5 h-5" />} title={t("shopifyApiVersionTitle")} step={t("advancedOptional")} accent="emerald">
                    <HtmlInfoBox html={t("shopifyApiVersionInfo")} />
                </Section>
            </div>
        </div>
    );
}

function StripeGuide({ onZoom }: { onZoom: (src: string) => void }) {
    const t = useTranslations("help");
    return (
        <div className="space-y-6">
            <div className="glass rounded-[2rem] p-5 sm:p-8 border-hairline space-y-6">
                <Section id="stripe-account-id" icon={<CreditCard className="w-5 h-5" />} title={t("stripeAccountIdTitle")} step={t("credentialTotal3")} accent="violet">
                    <HtmlInfoBox html={t("stripeAccountIdInfo")} />
                    <Steps accent="violet" items={[
                        t("stripeAccountIdStep1"),
                        t("stripeAccountIdStep2"),
                        t("stripeAccountIdStep3"),
                        t("stripeAccountIdStep4"),
                    ]} />
                </Section>
            </div>

            <div className="glass rounded-[2rem] p-5 sm:p-8 border-hairline space-y-6">
                <Section id="stripe-restricted-key" icon={<Key className="w-5 h-5" />} title={t("stripeRestrictedTitle")} step={t("credentialTotal3b")} accent="violet">
                    <HtmlInfoBox html={t("stripeRestrictedInfo")} />
                    <Steps accent="violet" items={[
                        t("stripeRestrictedStep1"),
                        t("stripeRestrictedStep2"),
                        t("stripeRestrictedStep3"),
                        t("stripeRestrictedStep4"),
                        t("stripeRestrictedStep5"),
                        t("stripeRestrictedStep6"),
                    ]} />
                    <HtmlWarningBox html={t("stripeRestrictedWarn")} />
                </Section>
            </div>

            <div className="glass rounded-[2rem] p-5 sm:p-8 border-hairline space-y-6">
                <Section id="stripe-webhook" icon={<Webhook className="w-5 h-5" />} title={t("stripeWebhookTitle")} step={t("credentialTotal3c")} accent="violet">
                    <HtmlInfoBox html={t("stripeWebhookInfo")} />
                    <Steps accent="violet" items={[
                        t("stripeWebhookStep1"),
                        t("stripeWebhookStep2"),
                        t("stripeWebhookStep3"),
                        t("stripeWebhookStep4"),
                        t("stripeWebhookStep5"),
                    ]} />
                    <HtmlWarningBox html={t("stripeWebhookWarn")} />
                </Section>
            </div>
        </div>
    );
}

function InvoiceXpressGuide({ onZoom }: { onZoom: (src: string) => void }) {
    const t = useTranslations("help");
    return (
        <div className="space-y-6">
            <div className="glass rounded-[2rem] p-5 sm:p-8 border-hairline space-y-6">
                <Section id="ix-account" icon={<FileText className="w-5 h-5" />} title={t("ixAccountTitle")} step={t("credentialTotal2a")} accent="sky">
                    <HtmlInfoBox html={t("ixAccountInfo")} />
                    <Steps accent="sky" items={[
                        t("ixAccountStep1"),
                        t("ixAccountStep2"),
                        t("ixAccountStep3"),
                        t("ixAccountStep4"),
                        t("ixAccountStep5"),
                        t("ixAccountStep6"),
                    ]} />
                    <Placeholder src="/images/help/ix-account.webp" alt="InvoiceXpress - Account name" description={t("ixAccountImageDesc")} onZoom={onZoom} />
                </Section>
            </div>

            <div className="glass rounded-[2rem] p-5 sm:p-8 border-hairline space-y-6">
                <Section id="ix-api-key" icon={<Key className="w-5 h-5" />} title={t("ixApiKeyTitle")} step={t("credentialTotal2b")} accent="sky">
                    <HtmlInfoBox html={t("ixApiKeyInfo")} />
                    <Steps accent="sky" items={[
                        t("ixApiKeyStep1"),
                        t("ixApiKeyStep2"),
                    ]} />
                    <Placeholder src="/images/help/ix-api-key.webp" alt="InvoiceXpress - API Key" description={t("ixApiKeyImageDesc")} onZoom={onZoom} />
                    <HtmlWarningBox html={t("ixApiKeyWarn")} />
                </Section>
            </div>

            <div className="glass rounded-[2rem] p-5 sm:p-8 border-hairline space-y-6">
                <Section id="ix-environment" icon={<Globe className="w-5 h-5" />} title={t("ixEnvTitle")} accent="sky">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="bg-[rgba(94,234,212,0.05)] border border-[rgba(94,234,212,0.20)] rounded-2xl p-5">
                            <div className="text-accent-hot font-black text-sm mb-2">{t("ixEnvProd")}</div>
                            <p className="text-fg-60 text-sm">{t("ixEnvProdBody")}</p>
                        </div>
                        <div className="bg-[rgba(245,158,11,0.05)] border border-[rgba(245,158,11,0.20)] rounded-2xl p-5">
                            <div className="text-soon font-black text-sm mb-2">{t("ixEnvSandbox")}</div>
                            <p className="text-fg-60 text-sm">{t("ixEnvSandboxBody")}</p>
                        </div>
                    </div>
                </Section>
            </div>

            <div className="glass rounded-[2rem] p-5 sm:p-8 border-hairline space-y-6">
                <Section id="ix-doc-type" icon={<FileText className="w-5 h-5" />} title={t("ixDocTypeTitle")} accent="sky">
                    <HtmlInfoBox html={t("ixDocTypeInfo")} />
                    <HtmlWarningBox html={t("ixDocTypeWarn")} />
                </Section>
            </div>

            <div className="glass rounded-[2rem] p-5 sm:p-8 border-hairline space-y-6">
                <Section id="ix-sequence" icon={<Settings2 className="w-5 h-5" />} title={t("ixSequenceTitle")} accent="sky">
                    <HtmlInfoBox html={t("ixSequenceInfo")} />
                    <Steps accent="sky" items={[
                        t("ixSequenceStep1"),
                        t("ixSequenceStep2"),
                        t("ixSequenceStep3"),
                    ]} />
                </Section>
            </div>
        </div>
    );
}

function MoloniGuide({ onZoom }: { onZoom: (src: string) => void }) {
    const t = useTranslations("help");
    return (
        <div className="space-y-6">
            <div className="glass rounded-[2rem] p-5 sm:p-8 border-hairline space-y-6">
                <Section id="moloni-dev-account" icon={<Key className="w-5 h-5" />} title={t("moloniDevTitle")} step={t("credentialTotal3")} accent="amber">
                    <HtmlInfoBox html={t("moloniDevInfo")} />
                    <Steps accent="amber" items={[
                        t("moloniDevStep1"),
                        t("moloniDevStep2"),
                        t("moloniDevStep3"),
                    ]} />
                </Section>
            </div>

            <div className="glass rounded-[2rem] p-5 sm:p-8 border-hairline space-y-6">
                <Section id="moloni-app" icon={<Settings2 className="w-5 h-5" />} title={t("moloniAppTitle")} step={t("credentialTotal3b")} accent="amber">
                    <HtmlInfoBox html={t("moloniAppInfo")} />
                    <Steps accent="amber" items={[
                        t("moloniAppStep1"),
                        t("moloniAppStep2"),
                        t("moloniAppStep3"),
                        t("moloniAppStep4"),
                        t("moloniAppStep5"),
                        t("moloniAppStep6"),
                    ]} />
                    <HtmlWarningBox html={t("moloniAppWarn")} />
                </Section>
            </div>

            <div className="glass rounded-[2rem] p-5 sm:p-8 border-hairline space-y-6">
                <Section id="moloni-credentials" icon={<Globe className="w-5 h-5" />} title={t("moloniCredsTitle")} step={t("credentialTotal3c")} accent="amber">
                    <HtmlInfoBox html={t("moloniCredsInfo")} />
                    <Steps accent="amber" items={[
                        t("moloniCredsStep1"),
                        t("moloniCredsStep2"),
                        t("moloniCredsStep3"),
                    ]} />
                    <HtmlWarningBox html={t("moloniCredsWarn")} />
                </Section>
            </div>

            <div className="glass rounded-[2rem] p-5 sm:p-8 border-hairline space-y-6">
                <Section id="moloni-document-types" icon={<FileText className="w-5 h-5" />} title={t("moloniDocTypesTitle")} accent="amber">
                    <HtmlInfoBox html={t("moloniDocTypesInfo")} />
                    <HtmlWarningBox html={t("moloniDocTypesWarn")} />
                </Section>
            </div>
        </div>
    );
}

// ─── FAQ ──────────────────────────────────────────────────────────────────

type FAQItem = { q: string; a: string };

function useFaqs(): Record<Platform, FAQItem[]> {
    const t = useTranslations("help");
    return {
        shopify: [
            { q: t("faqShopifyQ1"), a: t("faqShopifyA1") },
            { q: t("faqShopifyQ2"), a: t("faqShopifyA2") },
            { q: t("faqShopifyQ3"), a: t("faqShopifyA3") },
            { q: t("faqShopifyQ4"), a: t("faqShopifyA4") },
            { q: t("faqShopifyQ5"), a: t("faqShopifyA5") },
            { q: t("faqShopifyQ6"), a: t("faqShopifyA6") },
        ],
        stripe: [
            { q: t("faqStripeQ1"), a: t("faqStripeA1") },
            { q: t("faqStripeQ2"), a: t("faqStripeA2") },
            { q: t("faqStripeQ3"), a: t("faqStripeA3") },
            { q: t("faqStripeQ4"), a: t("faqStripeA4") },
            { q: t("faqStripeQ5"), a: t("faqStripeA5") },
        ],
        invoicexpress: [
            { q: t("faqIxQ1"), a: t("faqIxA1") },
            { q: t("faqIxQ2"), a: t("faqIxA2") },
            { q: t("faqIxQ3"), a: t("faqIxA3") },
            { q: t("faqIxQ4"), a: t("faqIxA4") },
            { q: t("faqIxQ5"), a: t("faqIxA5") },
        ],
        moloni: [
            { q: t("faqMoloniQ1"), a: t("faqMoloniA1") },
            { q: t("faqMoloniQ2"), a: t("faqMoloniA2") },
            { q: t("faqMoloniQ3"), a: t("faqMoloniA3") },
            { q: t("faqMoloniQ4"), a: t("faqMoloniA4") },
            { q: t("faqMoloniQ5"), a: t("faqMoloniA5") },
        ],
    };
}

function FAQ({ tab }: { tab: Platform }) {
    const t = useTranslations("help");
    const FAQS = useFaqs();
    const PLATFORMS = usePlatforms();
    const [open, setOpen] = useState<number | null>(null);
    const items = FAQS[tab];
    return (
        <div className="glass rounded-[2.5rem] p-8 lg:p-10 border-hairline space-y-6">
            <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-2xl bg-surface-2 border border-hairline flex items-center justify-center shrink-0 text-soon">
                    <BookOpen className="w-5 h-5" />
                </div>
                <div>
                    <div className="text-[10px] font-black text-fg-40 uppercase tracking-[0.2em] mb-1">{t("faqEyebrow")}</div>
                    <h2 className="text-2xl font-black text-white">{t("faqTitle", { platform: PLATFORMS.find(p => p.id === tab)?.label ?? "" })}</h2>
                </div>
            </div>
            <div className="ml-0 lg:ml-16 space-y-2">
                {items.map((it, i) => {
                    const isOpen = open === i;
                    return (
                        <div key={i} className="rounded-2xl border border-hairline/60 bg-surface-2/30 overflow-hidden">
                            <button
                                onClick={() => setOpen(isOpen ? null : i)}
                                aria-expanded={isOpen}
                                className="w-full flex items-center justify-between gap-4 px-5 py-4 text-left hover:bg-surface-2/50 transition-colors"
                            >
                                <span className="text-sm font-bold text-white" dangerouslySetInnerHTML={{ __html: it.q }} />
                                <ChevronDown className={`w-4 h-4 text-fg-40 shrink-0 transition-transform duration-300 ${isOpen ? "rotate-180 text-soon" : ""}`} />
                            </button>
                            <AnimatePresence initial={false}>
                                {isOpen && (
                                    <motion.div
                                        initial={{ height: 0, opacity: 0 }}
                                        animate={{ height: "auto", opacity: 1 }}
                                        exit={{ height: 0, opacity: 0 }}
                                        transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
                                        className="overflow-hidden"
                                    >
                                        <div className="px-5 pb-5 text-sm text-fg-60 leading-relaxed" dangerouslySetInnerHTML={{ __html: it.a }} />
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// Strip HTML tags so JSON-LD answers stay plain text — search engines render
// the FAQ rich result from this field literally.
function stripHtml(s: string): string {
    return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function FAQJsonLd({ tab }: { tab: Platform }) {
    const FAQS = useFaqs();
    const items = FAQS[tab];
    const data = {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: items.map(it => ({
            "@type": "Question",
            name: it.q,
            acceptedAnswer: {
                "@type": "Answer",
                text: stripHtml(it.a),
            },
        })),
    };
    return (
        <script
            type="application/ld+json"
            // Static JSON we built ourselves — safe to inline. Stripped of HTML
            // tags above so the structured data validators accept it.
            dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
        />
    );
}

// ─── Footer ───────────────────────────────────────────────────────────────

function HelpFooter() {
    const t = useTranslations("help");
    return (
        <div className="bg-surface-2/50 border border-hairline/60 rounded-[2.5rem] p-12 lg:p-20 relative overflow-hidden flex flex-col items-center text-center gap-8">
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-[rgba(245,158,11,0.20)] to-transparent" />
            <div className="w-20 h-20 bg-[rgba(245,158,11,0.10)] rounded-3xl flex items-center justify-center border border-[rgba(245,158,11,0.20)] shadow-[0_0_40px_rgba(245,158,11,0.1)]">
                <BookOpen className="w-10 h-10 text-soon" />
            </div>
            <div className="space-y-4 max-w-2xl">
                <h2 className="text-4xl font-black tracking-tight text-white">{t("footerTitle")}</h2>
                <p className="text-fg-60 font-medium leading-relaxed">
                    {t("footerBody")}
                </p>
            </div>
            <div className="flex flex-col sm:flex-row items-center gap-4">
                <a
                    href="https://calendly.com/pedro-kapta/apoio-kapta"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="bg-accent text-white px-6 sm:px-10 py-4 rounded-2xl font-mono text-sm uppercase tracking-[0.18em] hover:bg-accent/85 transition-all transform active:scale-95 shadow-xl flex items-center gap-3"
                >
                    <Calendar className="w-4 h-4" /> {t("scheduleMeeting")}
                </a>
                <a href="mailto:pedro@kapta.pt" className="bg-white text-black px-6 sm:px-10 py-4 rounded-2xl font-black text-sm uppercase tracking-widest hover:bg-accent-hot hover:text-surface transition-all transform active:scale-95 shadow-xl">
                    {t("footerContact")}
                </a>
                <button
                    onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
                    className="bg-surface-2/50 text-fg-60 px-4 py-4 rounded-2xl font-black text-sm uppercase tracking-widest hover:bg-surface-2 hover:text-fg transition-all border border-hairline"
                >
                    {t("footerTop")}
                </button>
            </div>
        </div>
    );
}

// ─── Page ─────────────────────────────────────────────────────────────────

export default function HelpPage() {
    const t = useTranslations("help");
    const [zoomImage, setZoomImage] = useState<string | null>(null);
    const [tab, setTab] = useState<Platform>("shopify");

    return (
        <div className="max-w-3xl mx-auto space-y-6 animate-in fade-in duration-700">
            <Link href="/dashboard" className="inline-flex items-center gap-2 text-fg-40 hover:text-fg text-sm font-bold transition-all group">
                <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
                {t("backToDashboard")}
            </Link>

            {/* Page Header */}
            <div className="glass rounded-[2rem] p-6 sm:p-10 border-hairline">
                <div className="flex items-center gap-4 mb-4">
                    <div className="w-14 h-14 rounded-2xl bg-surface-2 border border-hairline flex items-center justify-center">
                        <BookOpen className="w-7 h-7 text-soon" />
                    </div>
                    <div>
                        <h1 className="text-4xl font-black tracking-tight bg-gradient-to-r from-fg via-fg to-fg-40 bg-clip-text text-transparent">
                            {t("pageTitle")}
                        </h1>
                        <p className="text-fg-60 font-semibold mt-1">{t("pageSubtitle")}</p>
                    </div>
                </div>
                <p className="text-fg-60 text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: t("pageIntro") }} />
            </div>

            <PlatformTabs tab={tab} onChange={setTab} />

            {/* Active platform guide */}
            <AnimatePresence mode="wait">
                <motion.div
                    key={tab}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
                    className="space-y-6"
                >
                    {tab === "shopify" && <ShopifyGuide onZoom={setZoomImage} />}
                    {tab === "stripe" && <StripeGuide onZoom={setZoomImage} />}
                    {tab === "invoicexpress" && <InvoiceXpressGuide onZoom={setZoomImage} />}
                    {tab === "moloni" && <MoloniGuide onZoom={setZoomImage} />}
                </motion.div>
            </AnimatePresence>

            <FAQ tab={tab} />
            <FAQJsonLd tab={tab} />

            {/* Image Zoom Modal */}
            <AnimatePresence>
                {zoomImage && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 z-50 flex items-center justify-center p-4 md:p-10 bg-surface/90 backdrop-blur-xl cursor-zoom-out"
                        onClick={() => setZoomImage(null)}
                    >
                        <motion.button
                            initial={{ scale: 0.5, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            className="absolute top-6 right-6 w-12 h-12 rounded-full bg-white/10 flex items-center justify-center text-white hover:bg-white/20 transition-colors border border-white/10"
                        >
                            <X className="w-6 h-6" />
                        </motion.button>
                        <motion.div
                            initial={{ scale: 0.9, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.9, opacity: 0 }}
                            className="relative w-full h-full flex items-center justify-center lg:max-w-6xl"
                        >
                            <Image src={zoomImage} alt="Zoom View" fill className="object-contain" priority />
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>

            <HelpFooter />
        </div>
    );
}
