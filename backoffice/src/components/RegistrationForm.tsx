"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ShieldCheck, ArrowRight, User, Building2, MapPin, Phone, Globe, Mail, CheckCircle2 } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

interface RegistrationFormProps {
    onComplete: () => void;
    initialEmail?: string;
    initialName?: string;
}

export function RegistrationForm({ onComplete, initialEmail, initialName }: RegistrationFormProps) {
    const t = useTranslations("registrationForm");
    const [loading, setLoading] = useState(false);
    const [formData, setFormData] = useState({
        nif: "",
        name: initialName || "",
        company_name: "",
        fiscal_address: "",
        phone: "",
        email: initialEmail || "",
        website: "",
        privacy_policy_accepted: false
    });

    const isCompany = (nif: string) => {
        if (!nif || nif.length < 1) return false;
        const firstDigit = nif[0];
        return ["5", "6", "8", "9"].includes(firstDigit);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        try {
            const res = await fetch("/api/user/profile", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(formData)
            });
            if (res.ok) {
                onComplete();
            }
        } catch (error) {
            console.error("Error saving profile:", error);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
            <div className="glass p-6 sm:p-12 rounded-[3.5rem] relative overflow-hidden">
                <div className="absolute top-0 right-0 p-6 sm:p-12 opacity-5 pointer-events-none">
                    <ShieldCheck className="w-64 h-64 text-accent" />
                </div>

                <div className="space-y-2 mb-10 text-center relative z-10">
                    <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[rgba(2,141,196,0.10)] border border-[rgba(2,141,196,0.20)] text-accent font-mono text-[10px] uppercase tracking-[0.22em] mb-4">
                        <ShieldCheck className="w-3 h-3" /> {t("chip")}
                    </div>
                    <h2 className="text-4xl font-medium tracking-tight text-fg mb-4">{t("title")}</h2>
                    <p className="text-fg-60 text-lg max-w-xl mx-auto">
                        {t("subtitle")}
                    </p>
                </div>

                <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-6 relative z-10">
                    {/* NIF */}
                    <div className="space-y-2 md:col-span-2">
                        <label className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em] ml-4">{t("nifLabel")}</label>
                        <div className="relative group">
                            <ShieldCheck className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-40 group-focus-within:text-accent transition-colors" />
                            <input
                                required
                                type="text"
                                maxLength={9}
                                placeholder={t("nifPlaceholder")}
                                className="w-full bg-surface-2 border border-hairline rounded-2xl py-4 pl-14 pr-6 text-sm font-medium text-fg focus:ring-2 focus:ring-[rgba(2,141,196,0.20)] focus:border-[rgba(2,141,196,0.50)] transition-all outline-none"
                                value={formData.nif}
                                onChange={(e) => setFormData({ ...formData, nif: e.target.value })}
                            />
                        </div>
                    </div>

                    {/* Conditional Name/Company Name */}
                    <div className="space-y-2 md:col-span-2">
                        <label className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em] ml-4">
                            {isCompany(formData.nif) ? t("companyNameLabel") : t("personNameLabel")}
                        </label>
                        <div className="relative group">
                            {isCompany(formData.nif) ? (
                                <Building2 className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-40 group-focus-within:text-accent transition-colors" />
                            ) : (
                                <User className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-40 group-focus-within:text-accent transition-colors" />
                            )}
                            <input
                                required
                                type="text"
                                placeholder={isCompany(formData.nif) ? t("companyNamePlaceholder") : t("personNamePlaceholder")}
                                className="w-full bg-surface-2 border border-hairline rounded-2xl py-4 pl-14 pr-6 text-sm font-medium text-fg focus:ring-2 focus:ring-[rgba(2,141,196,0.20)] focus:border-[rgba(2,141,196,0.50)] transition-all outline-none"
                                value={isCompany(formData.nif) ? formData.company_name : formData.name}
                                onChange={(e) => {
                                    if (isCompany(formData.nif)) {
                                        setFormData({ ...formData, company_name: e.target.value });
                                    } else {
                                        setFormData({ ...formData, name: e.target.value });
                                    }
                                }}
                            />
                        </div>
                    </div>

                    {/* Fiscal Address */}
                    <div className="space-y-2 md:col-span-2">
                        <label className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em] ml-4">{t("addressLabel")}</label>
                        <div className="relative group">
                            <MapPin className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-40 group-focus-within:text-accent transition-colors" />
                            <input
                                required
                                type="text"
                                placeholder={t("addressPlaceholder")}
                                className="w-full bg-surface-2 border border-hairline rounded-2xl py-4 pl-14 pr-6 text-sm font-medium text-fg focus:ring-2 focus:ring-[rgba(2,141,196,0.20)] focus:border-[rgba(2,141,196,0.50)] transition-all outline-none"
                                value={formData.fiscal_address}
                                onChange={(e) => setFormData({ ...formData, fiscal_address: e.target.value })}
                            />
                        </div>
                    </div>

                    {/* Email */}
                    <div className="space-y-2">
                        <label className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em] ml-4">{t("emailLabel")}</label>
                        <div className="relative group">
                            <Mail className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-40 group-focus-within:text-accent transition-colors" />
                            <input
                                required
                                type="email"
                                className="w-full bg-surface-2 border border-hairline rounded-2xl py-4 pl-14 pr-6 text-sm font-medium text-fg focus:ring-2 focus:ring-[rgba(2,141,196,0.20)] focus:border-[rgba(2,141,196,0.50)] transition-all outline-none"
                                value={formData.email}
                                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                            />
                        </div>
                    </div>

                    {/* Phone */}
                    <div className="space-y-2">
                        <label className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em] ml-4">{t("phoneLabel")}</label>
                        <div className="relative group">
                            <Phone className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-40 group-focus-within:text-accent transition-colors" />
                            <input
                                type="tel"
                                className="w-full bg-surface-2 border border-hairline rounded-2xl py-4 pl-14 pr-6 text-sm font-medium text-fg focus:ring-2 focus:ring-[rgba(2,141,196,0.20)] focus:border-[rgba(2,141,196,0.50)] transition-all outline-none"
                                value={formData.phone}
                                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                            />
                        </div>
                    </div>

                    {/* Website */}
                    <div className="space-y-2 md:col-span-2">
                        <label className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em] ml-4">{t("websiteLabel")}</label>
                        <div className="relative group">
                            <Globe className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-40 group-focus-within:text-accent transition-colors" />
                            <input
                                type="url"
                                placeholder={t("websitePlaceholder")}
                                className="w-full bg-surface-2 border border-hairline rounded-2xl py-4 pl-14 pr-6 text-sm font-medium text-fg focus:ring-2 focus:ring-[rgba(2,141,196,0.20)] focus:border-[rgba(2,141,196,0.50)] transition-all outline-none"
                                value={formData.website}
                                onChange={(e) => setFormData({ ...formData, website: e.target.value })}
                            />
                        </div>
                    </div>

                    {/* Privacy Policy */}
                    <div className="md:col-span-2 py-4">
                        <label className="flex items-center gap-3 cursor-pointer group">
                            <div className="relative">
                                <input
                                    required
                                    type="checkbox"
                                    className="peer sr-only"
                                    checked={formData.privacy_policy_accepted}
                                    onChange={(e) => setFormData({ ...formData, privacy_policy_accepted: e.target.checked })}
                                />
                                <div className="w-6 h-6 border-2 border-hairline rounded-lg bg-surface-2 group-hover:border-[rgba(2,141,196,0.50)] peer-checked:bg-accent peer-checked:border-accent transition-all flex items-center justify-center">
                                    <CheckCircle2 className="w-4 h-4 text-fg opacity-0 peer-checked:opacity-100 transition-opacity" />
                                </div>
                            </div>
                            <span className="text-sm font-medium text-fg-60 group-hover:text-fg transition-colors">
                                {t("privacyAccept")}
                            </span>
                        </label>
                    </div>

                    {/* Submit */}
                    <button
                        disabled={loading}
                        type="submit"
                        className={cn(
                            "md:col-span-2 mt-4 bg-fg text-surface font-mono uppercase tracking-[0.18em] py-5 rounded-3xl hover:bg-accent-hot transition-all transform active:scale-[0.98] flex items-center justify-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_8px_30px_-12px_rgba(2,141,196,0.45)]"
                        )}
                    >
                        {loading ? t("saving") : t("submit")} <ArrowRight className="w-5 h-5" />
                    </button>
                </form>
            </div>
        </div>
    );
}
