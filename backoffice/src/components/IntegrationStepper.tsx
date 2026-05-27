"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useState, type ReactNode } from "react";
import { Check, Lock, Circle, HelpCircle, Info, ShieldCheck, Loader2, X, Settings2, ArrowLeft } from "lucide-react";
import Image from "next/image";
import { Link } from "@/i18n/navigation";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { LucideIcon } from "lucide-react";

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

export type StepDef = {
    id: number;
    title: string;
    description: string;
    icon: LucideIcon;
    logo?: string;
    logoWidth?: number;
    hasGearLogo?: boolean;
    isAuthorized: boolean;
    isConfig?: boolean;
    errorMsg?: string;
    flagName?: string;
    body: ReactNode;
};

export type StepperLabels = {
    update: string;
    back: string;
    statusAuthorized: string;
    statusPending: string;
    diagnostic: string;
    diagnosticSub: string;
    diagnosticDefault: string;
    forceAuth: string;
    areYouSure: string;
    cancelAction: string;
    alertForceAuthError?: string;
};

type Props = {
    steps: StepDef[];
    step: number;
    setStep: (n: number) => void;
    userRole?: string;
    targetUserId?: string;
    onForceAuth?: (flag: string) => Promise<boolean>;
    saving?: boolean;
    labels: StepperLabels;
};

export function IntegrationStepper({ steps, step, setStep, userRole, onForceAuth, saving = false, labels }: Props) {
    const [openDiagnostic, setOpenDiagnostic] = useState<number | null>(null);

    const StatusBadge = ({ isAuthorized, errorMsg, stepId, flagName }: { isAuthorized: boolean; errorMsg?: string; stepId: number; flagName?: string }) => {
        const isHiper = userRole === "hiperadmin" || userRole === "superadmin";
        const isOpen = openDiagnostic === stepId;
        const [isHovered, setIsHovered] = useState(false);
        const [showConfirm, setShowConfirm] = useState(false);
        const [forcing, setForcing] = useState(false);

        const handleManualForce = async (e: React.MouseEvent) => {
            e.stopPropagation();
            if (!showConfirm) { setShowConfirm(true); return; }
            if (!flagName || !onForceAuth) return;
            setForcing(true);
            try {
                const ok = await onForceAuth(flagName);
                if (ok) setOpenDiagnostic(null);
                else if (labels.alertForceAuthError) alert(labels.alertForceAuthError);
            } finally {
                setForcing(false);
                setShowConfirm(false);
            }
        };

        const showPanel = isOpen || isHovered;

        return (
            <div className="relative" onMouseEnter={() => setIsHovered(true)} onMouseLeave={() => setIsHovered(false)}>
                <button
                    onClick={(e) => { e.stopPropagation(); setOpenDiagnostic(isOpen ? null : stepId); setShowConfirm(false); }}
                    className={cn(
                        "px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-[0.15em] border flex items-center gap-2 transition-all active:scale-95",
                        isAuthorized ? "bg-[rgba(94,234,212,0.10)] text-accent-hot border-[rgba(94,234,212,0.20)]" : "bg-[rgba(245,158,11,0.10)] text-soon border-[rgba(245,158,11,0.20)] hover:bg-[rgba(245,158,11,0.20)]",
                        isOpen && "ring-2 ring-[rgba(245,158,11,0.30)]"
                    )}
                >
                    {isAuthorized ? labels.statusAuthorized : labels.statusPending}
                    {!isAuthorized && <HelpCircle className={cn("w-3 h-3 cursor-help transition-transform", isOpen && "rotate-180")} />}
                </button>
                <AnimatePresence>
                    {!isAuthorized && showPanel && (
                        <motion.div
                            initial={{ opacity: 0, y: 10, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 10, scale: 0.95 }}
                            className="absolute bottom-full left-1/2 -translate-x-1/2 mb-4 w-[90vw] max-w-[20rem] p-6 bg-surface-2 border-2 border-[rgba(245,158,11,0.20)] rounded-[2rem] shadow-[0_20px_60px_rgba(0,0,0,0.9)] z-[100] backdrop-blur-3xl pointer-events-auto"
                        >
                            <div className="flex items-center justify-between mb-4">
                                <div className="flex items-center gap-3 text-soon">
                                    <div className="bg-[rgba(245,158,11,0.10)] p-2 rounded-xl ring-1 ring-[rgba(245,158,11,0.20)]"><Info className="w-5 h-5" /></div>
                                    <div className="flex flex-col text-left">
                                        <p className="text-[10px] font-black uppercase tracking-[0.2em] leading-none">{labels.diagnostic}</p>
                                        <p className="text-[10px] font-bold text-soon/60 uppercase mt-1">{labels.diagnosticSub}</p>
                                    </div>
                                </div>
                                {isOpen && <button onClick={() => setOpenDiagnostic(null)} className="p-1 hover:bg-white/5 rounded-lg text-fg-40 transition-colors"><X className="w-4 h-4" /></button>}
                            </div>
                            <div className="bg-black/40 rounded-[1.25rem] p-4 border border-white/5 mb-4">
                                <p className="text-[13px] text-fg font-bold leading-relaxed text-left">{errorMsg || labels.diagnosticDefault}</p>
                            </div>
                            {isHiper && isOpen && flagName && onForceAuth && (
                                <div className="space-y-2">
                                    <button onClick={handleManualForce} disabled={forcing || saving} className={cn("w-full py-3 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all flex items-center justify-center gap-2", showConfirm ? "bg-destructive text-white hover:bg-destructive/85 animate-pulse" : "bg-soon text-surface hover:bg-soon/85")}>
                                        {forcing ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldCheck className="w-3 h-3" />}
                                        {showConfirm ? labels.areYouSure : labels.forceAuth}
                                    </button>
                                    {showConfirm && <button onClick={() => setShowConfirm(false)} className="w-full text-[10px] font-bold text-fg-40 uppercase tracking-widest hover:text-fg transition-colors py-1">{labels.cancelAction}</button>}
                                </div>
                            )}
                            <div className="absolute -bottom-2.5 left-1/2 -translate-x-1/2 w-5 h-5 bg-surface-2 rotate-45 border-r-2 border-b-2 border-[rgba(245,158,11,0.10)]" />
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        );
    };

    return (
        <div className="grid gap-8">
            {steps.map((s) => {
                const isActive = step === s.id;
                const isComplete = step > s.id;
                const isLocked = step < s.id;
                const StepIcon = s.icon;
                return (
                    <motion.div key={s.id} initial={false} animate={{ scale: isActive ? 1.01 : 1, opacity: isLocked ? 0.35 : 1, y: isActive ? -4 : 0 }}
                        className={cn("glass rounded-[2rem] overflow-visible relative group transition-all duration-700",
                            isActive && "border-accent/40 shadow-[0_20px_50px_rgba(0,0,0,0.5),0_0_30px_rgba(2,141,196,0.10)]",
                            isComplete && s.isAuthorized && "border-[rgba(94,234,212,0.30)] bg-[rgba(94,234,212,0.04)]",
                            isComplete && !s.isAuthorized && "border-[rgba(245,158,11,0.30)] bg-[rgba(245,158,11,0.04)]",
                            isLocked && "grayscale scale-[0.98] !overflow-hidden"
                        )}
                    >
                        <div className="p-6 sm:p-10 flex flex-col lg:flex-row items-start lg:items-center gap-10">
                            <div className={cn("w-20 h-20 rounded-2xl flex items-center justify-center transition-all duration-700 shrink-0 shadow-inner p-1",
                                isActive ? "bg-accent/20 text-accent ring-1 ring-accent/30"
                                    : isComplete ? (s.isAuthorized ? "bg-[rgba(94,234,212,0.18)] text-accent-hot ring-1 ring-[rgba(94,234,212,0.30)]" : "bg-[rgba(245,158,11,0.10)] text-soon ring-1 ring-[rgba(245,158,11,0.30)]")
                                        : "bg-surface-2/50 text-fg-40 ring-1 ring-hairline"
                            )}>
                                {isComplete
                                    ? (s.isAuthorized ? <Check className="w-10 h-10 stroke-[3]" /> : <Circle className="w-10 h-10 stroke-[4] text-soon" />)
                                    : (isLocked ? <Lock className="w-8 h-8 opacity-30" /> : <StepIcon className="w-10 h-10 stroke-[1.5]" />)}
                            </div>
                            <div className="flex-1 space-y-2">
                                <div className="flex items-center gap-4 flex-wrap">
                                    <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2.5">
                                        {s.isConfig && <Settings2 className="w-6 h-6 text-fg-60 group-hover:text-fg transition-colors" />}
                                        {s.title}
                                    </h2>
                                    {(isComplete || isActive) && <StatusBadge isAuthorized={s.isAuthorized} errorMsg={s.errorMsg} stepId={s.id} flagName={s.flagName} />}
                                    {isActive && <div className="h-1.5 w-1.5 rounded-full bg-accent animate-ping" />}
                                </div>
                                <p className="text-fg-60 font-medium leading-relaxed max-w-xl">{s.description}</p>
                            </div>
                            <div className="flex items-center gap-10 w-full lg:w-auto">
                                {s.logo && <div className={cn("hidden xl:block transition-all duration-700 transform", isActive ? "opacity-100 grayscale-0" : "opacity-20 grayscale")}><Image src={s.logo} alt={s.title} width={s.logoWidth ?? 80} height={40} className="object-contain" /></div>}
                                {s.hasGearLogo && <div className={cn("hidden xl:block transition-all duration-700", isActive ? "opacity-100" : "opacity-20")}><Settings2 className="w-16 h-16 text-fg-60 stroke-[1]" /></div>}
                                {isComplete && <button onClick={() => setStep(s.id)} className="ml-auto bg-surface-2 hover:bg-surface-2 text-fg px-5 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all border border-hairline/50">{labels.update}</button>}
                            </div>
                        </div>
                        <motion.div animate={{ height: isActive ? "auto" : 0 }} className="overflow-hidden bg-surface/40 border-t border-hairline">
                            {isActive && (
                                <div className="p-6 sm:p-10 pt-8 animate-in zoom-in-95 duration-700">
                                    {s.body}
                                </div>
                            )}
                        </motion.div>
                    </motion.div>
                );
            })}
        </div>
    );
}

export function StepperHeader({
    backHref, backLabel, title, subtitle, providers, allComplete, syncStateLabel, realtimeOnLabel, waitingLabel,
}: {
    backHref: string;
    backLabel: string;
    title: string;
    subtitle: string;
    providers: Array<{ icon: LucideIcon; authorized: boolean; color?: "accent" | "accentHot" }>;
    allComplete: boolean;
    syncStateLabel: string;
    realtimeOnLabel: string;
    waitingLabel: string;
}) {
    return (
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-8">
            <div className="space-y-2">
                <Link href={backHref} className="text-[10px] font-black text-accent uppercase tracking-widest hover:text-fg transition-colors flex items-center gap-2 mb-4">
                    <ArrowLeft className="w-3 h-3" /> {backLabel}
                </Link>
                <h1 className="text-3xl sm:text-4xl lg:text-5xl font-black tracking-tight bg-gradient-to-r from-fg via-fg to-fg-40 bg-clip-text text-transparent">{title}</h1>
                <p className="text-fg-60 font-semibold tracking-wide flex items-center gap-2">
                    Rioko 2.0 Engine <span className="w-1 h-1 rounded-full bg-fg-40" /> {subtitle}
                </p>
            </div>
            <div className="flex items-center gap-5 glass px-5 py-3 rounded-2xl border-hairline">
                <div className="flex -space-x-2.5">
                    {providers.map((p, i) => {
                        const I = p.icon;
                        const colorClass = p.color === "accentHot" ? "text-accent-hot bg-[rgba(94,234,212,0.10)] border-[rgba(94,234,212,0.30)]" : "text-accent bg-[rgba(2,141,196,0.10)] border-[rgba(2,141,196,0.30)]";
                        return (
                            <div key={i} className={cn("h-9 w-9 rounded-full ring-4 ring-surface flex items-center justify-center border", p.authorized ? colorClass : "bg-surface-2 border-hairline")}>
                                <I className={cn("w-4 h-4", p.authorized ? "" : "text-fg-40")} />
                            </div>
                        );
                    })}
                </div>
                <div className="flex flex-col">
                    <span className="text-[10px] font-black text-fg-40 uppercase tracking-[0.2em]">{syncStateLabel}</span>
                    <span className={cn("text-xs font-bold flex items-center gap-1.5", allComplete ? "text-accent-hot" : "text-fg-40 animate-pulse")}>
                        <span className={cn("w-1.5 h-1.5 rounded-full", allComplete ? "bg-accent-hot animate-pulse" : "bg-surface-2")} />
                        {allComplete ? realtimeOnLabel : waitingLabel}
                    </span>
                </div>
            </div>
        </div>
    );
}
