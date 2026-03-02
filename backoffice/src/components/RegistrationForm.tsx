"use client";

import { useState } from "react";
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
        // Simple logic for PT NIFs:
        // Companies/Entities usually start with 5, 6, 8, 9
        // Individuals usually start with 1, 2, 3
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
            <div className="glass p-12 rounded-[3.5rem] border-sky-500/30 relative overflow-hidden">
                <div className="absolute top-0 right-0 p-12 opacity-5 pointer-events-none">
                    <ShieldCheck className="w-64 h-64 text-sky-400" />
                </div>

                <div className="space-y-2 mb-10 text-center relative z-10">
                    <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-sky-500/10 border border-sky-500/20 text-sky-400 text-[10px] font-black uppercase tracking-widest mb-4">
                        <ShieldCheck className="w-3 h-3" /> Registo Obrigatório
                    </div>
                    <h2 className="text-4xl font-black tracking-tight text-white mb-4">Finalize o seu perfil</h2>
                    <p className="text-slate-400 text-lg max-w-xl mx-auto">
                        Para desbloquear as integrações e começar a faturar, precisamos dos seus dados fiscais.
                    </p>
                </div>

                <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-6 relative z-10">
                    {/* NIF */}
                    <div className="space-y-2 md:col-span-2">
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-4">NIF (Número de Identificação Fiscal)</label>
                        <div className="relative group">
                            <ShieldCheck className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 group-focus-within:text-sky-400 transition-colors" />
                            <input
                                required
                                type="text"
                                maxLength={9}
                                placeholder="Ex: 512345678"
                                className="w-full bg-slate-900/50 border border-slate-800 rounded-2xl py-4 pl-14 pr-6 text-sm font-bold focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500/50 transition-all outline-none"
                                value={formData.nif}
                                onChange={(e) => setFormData({ ...formData, nif: e.target.value })}
                            />
                        </div>
                    </div>

                    {/* Conditional Name/Company Name */}
                    <div className="space-y-2 md:col-span-2">
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-4">
                            {isCompany(formData.nif) ? "Nome da Empresa / Pessoa Coletiva" : "Nome Completo"}
                        </label>
                        <div className="relative group">
                            {isCompany(formData.nif) ? (
                                <Building2 className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 group-focus-within:text-sky-400 transition-colors" />
                            ) : (
                                <User className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 group-focus-within:text-sky-400 transition-colors" />
                            )}
                            <input
                                required
                                type="text"
                                placeholder={isCompany(formData.nif) ? "Ex: Minha Empresa Lda." : "Ex: João Silva"}
                                className="w-full bg-slate-900/50 border border-slate-800 rounded-2xl py-4 pl-14 pr-6 text-sm font-bold focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500/50 transition-all outline-none"
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
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-4">Morada Fiscal</label>
                        <div className="relative group">
                            <MapPin className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 group-focus-within:text-sky-400 transition-colors" />
                            <input
                                required
                                type="text"
                                placeholder="Rua, Número, Código Postal, Localidade"
                                className="w-full bg-slate-900/50 border border-slate-800 rounded-2xl py-4 pl-14 pr-6 text-sm font-bold focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500/50 transition-all outline-none"
                                value={formData.fiscal_address}
                                onChange={(e) => setFormData({ ...formData, fiscal_address: e.target.value })}
                            />
                        </div>
                    </div>

                    {/* Email */}
                    <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-4">Email de Contacto</label>
                        <div className="relative group">
                            <Mail className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 group-focus-within:text-sky-400 transition-colors" />
                            <input
                                required
                                type="email"
                                className="w-full bg-slate-900/50 border border-slate-800 rounded-2xl py-4 pl-14 pr-6 text-sm font-bold focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500/50 transition-all outline-none"
                                value={formData.email}
                                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                            />
                        </div>
                    </div>

                    {/* Phone */}
                    <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-4">Telemóvel (Opcional)</label>
                        <div className="relative group">
                            <Phone className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 group-focus-within:text-sky-400 transition-colors" />
                            <input
                                type="tel"
                                className="w-full bg-slate-900/50 border border-slate-800 rounded-2xl py-4 pl-14 pr-6 text-sm font-bold focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500/50 transition-all outline-none"
                                value={formData.phone}
                                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                            />
                        </div>
                    </div>

                    {/* Website */}
                    <div className="space-y-2 md:col-span-2">
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-4">Website (Opcional)</label>
                        <div className="relative group">
                            <Globe className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 group-focus-within:text-sky-400 transition-colors" />
                            <input
                                type="url"
                                placeholder="https://exemplo.com"
                                className="w-full bg-slate-900/50 border border-slate-800 rounded-2xl py-4 pl-14 pr-6 text-sm font-bold focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500/50 transition-all outline-none"
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
                                <div className="w-6 h-6 border-2 border-slate-700 rounded-lg bg-slate-900 group-hover:border-sky-500/50 peer-checked:bg-sky-500 peer-checked:border-sky-500 transition-all flex items-center justify-center">
                                    <CheckCircle2 className="w-4 h-4 text-white opacity-0 peer-checked:opacity-100 transition-opacity" />
                                </div>
                            </div>
                            <span className="text-sm font-bold text-slate-400 group-hover:text-slate-300 transition-colors">
                                Concordo com a política de privacidade e tratamento de dados.
                            </span>
                        </label>
                    </div>

                    {/* Submit */}
                    <button
                        disabled={loading}
                        type="submit"
                        className="md:col-span-2 mt-4 bg-white text-black font-black py-5 rounded-3xl hover:bg-sky-400 hover:text-white transition-all transform active:scale-[0.98] flex items-center justify-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed shadow-2xl shadow-sky-500/10"
                    >
                        {loading ? "A guardar..." : "Concluir Registo e Desbloquear"} <ArrowRight className="w-5 h-5" />
                    </button>
                </form>
            </div>
        </div>
    );
}
