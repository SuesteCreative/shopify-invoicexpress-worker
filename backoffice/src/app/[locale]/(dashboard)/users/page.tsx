"use client";

export const runtime = "edge";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Users, UserPlus, Loader2, Trash2, ShieldCheck, Eye, Mail, Crown, AlertCircle, Lock, UserRound } from "lucide-react";
import { useTranslations } from "next-intl";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

interface Member {
    id: string;
    email: string;
    member_user_id: string | null;
    role: "admin" | "viewer" | string;
    status: "pending" | "active" | string;
    created_at: string;
    accepted_at: string | null;
}

interface MembersResponse {
    account_id: string;
    access: "owner" | "admin" | "viewer";
    owner: { id: string; email: string | null; label: string };
    members: Member[];
    seat_price: { amount_cents: number; currency: string } | null;
    seats: { paid: number; occupied: number; free: number };
    can_invite: boolean;
    can_unlock: boolean;
    unlock_block_reason: string | null;
}

function formatMoney(cents: number, currency: string) {
    return new Intl.NumberFormat("pt-PT", { style: "currency", currency: (currency || "eur").toUpperCase() }).format(cents / 100);
}

function formatDate(iso: string) {
    return new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z").toLocaleDateString("pt-PT");
}

export default function UsersPage() {
    const t = useTranslations("users");
    const [data, setData] = useState<MembersResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [acting, setActing] = useState<string | null>(null);
    const [email, setEmail] = useState("");
    const [role, setRole] = useState<"admin" | "viewer">("viewer");
    const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
    const emailRef = useRef<HTMLInputElement>(null);

    const load = async () => {
        try {
            const r = await fetch("/api/account/members");
            setData((await r.json()) as MembersResponse);
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { load(); }, []);

    const errorText = (code: string, detail?: string) => {
        switch (code) {
            case "invalid_email": return t("invalidEmail");
            case "already_member": return t("alreadyMember");
            case "already_owner": return t("alreadyOwner");
            case "no_free_seat": return t("noFreeSeat");
            case "subscription_required": return t("needSubscription");
            case "payment_failed": return t("paymentFailed", { detail: detail || "" });
            case "read_only_member":
            case "read_only": return t("readOnlyNotice");
            default: return t("genericError");
        }
    };

    const priceLabel = data?.seat_price
        ? formatMoney(data.seat_price.amount_cents, data.seat_price.currency)
        : "1,50 €";

    const handleUnlock = async () => {
        if (!confirm(t("unlockConfirm", { amount: priceLabel }))) return;
        setActing("unlock");
        setNotice(null);
        try {
            const r = await fetch("/api/account/seats", { method: "POST" });
            const d: any = await r.json();
            if (d.ok) {
                setNotice({ kind: "ok", text: t("unlocked") });
                await load();
                emailRef.current?.focus();
            } else {
                setNotice({ kind: "error", text: errorText(d.error, d.detail) });
            }
        } catch (e: any) {
            setNotice({ kind: "error", text: e?.message || t("genericError") });
        } finally {
            setActing(null);
        }
    };

    const handleInvite = async () => {
        const address = email.trim().toLowerCase();
        if (!address) return;
        setActing("invite");
        setNotice(null);
        try {
            const r = await fetch("/api/account/members", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email: address, role }),
            });
            const d: any = await r.json();
            if (d.ok) {
                setEmail("");
                setNotice({ kind: "ok", text: d.joined_now ? t("joinedNow", { email: address }) : t("inviteSent", { email: address }) });
                await load();
            } else {
                setNotice({ kind: "error", text: errorText(d.error, d.detail) });
            }
        } catch (e: any) {
            setNotice({ kind: "error", text: e?.message || t("genericError") });
        } finally {
            setActing(null);
        }
    };

    const handleRole = async (member: Member, next: "admin" | "viewer") => {
        setActing(member.id);
        try {
            const r = await fetch(`/api/account/members/${member.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ role: next }),
            });
            const d: any = await r.json();
            if (d.ok) await load();
            else setNotice({ kind: "error", text: errorText(d.error) });
        } finally {
            setActing(null);
        }
    };

    const handleRemove = async (member: Member) => {
        if (!confirm(t("removeConfirm", { email: member.email }))) return;
        setActing(member.id);
        try {
            const r = await fetch(`/api/account/members/${member.id}`, { method: "DELETE" });
            const d: any = await r.json();
            if (d.ok) await load();
            else setNotice({ kind: "error", text: errorText(d.error) });
        } finally {
            setActing(null);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-[400px]">
                <Loader2 className="w-8 h-8 text-accent animate-spin" />
            </div>
        );
    }

    const canManage = data?.access === "owner" || data?.access === "admin";
    const freeSeats = data?.seats?.free ?? 0;
    const roleTag = (r: string) => (r === "admin" ? t("roleAdmin") : t("roleViewer"));

    return (
        <div className="max-w-5xl mx-auto space-y-10 animate-in fade-in duration-1000 slide-in-from-bottom-4">
            <div className="space-y-4">
                <h1 className="text-3xl sm:text-4xl lg:text-5xl font-medium tracking-tight bg-gradient-to-r from-fg via-fg to-fg-40 bg-clip-text text-transparent">
                    {t("title")}
                </h1>
                <p className="text-fg-60 font-medium tracking-wide max-w-2xl">{t("subtitle")}</p>
            </div>

            {!canManage && (
                <div className="flex items-center gap-3 px-5 py-4 rounded-2xl border border-hairline bg-surface-2/40 text-fg-60">
                    <Eye className="w-4 h-4 shrink-0 text-fg-40" />
                    <p className="text-[12px]">{t("readOnlyNotice")}</p>
                </div>
            )}

            {notice && (
                <div className={cn(
                    "flex items-start gap-3 px-5 py-4 rounded-2xl border text-[12px]",
                    notice.kind === "ok"
                        ? "border-[rgba(94,234,212,0.30)] bg-[rgba(94,234,212,0.08)] text-accent-hot"
                        : "border-[rgba(244,63,94,0.30)] bg-[rgba(244,63,94,0.08)] text-destructive"
                )}>
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <p>{notice.text}</p>
                </div>
            )}

            {/* Invite form — only with an empty seat to put someone in */}
            {canManage && freeSeats > 0 && (
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="glass rounded-[2rem] p-5 sm:p-8 space-y-5">
                    <div className="flex items-center gap-2">
                        <UserPlus className="w-4 h-4 text-accent" />
                        <span className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">{t("inviteTitle")}</span>
                    </div>

                    <div className="flex flex-col lg:flex-row gap-3">
                        <div className="flex-1 relative">
                            <Mail className="w-4 h-4 text-fg-40 absolute left-4 top-1/2 -translate-y-1/2" />
                            <input
                                ref={emailRef}
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                placeholder={t("emailPlaceholder")}
                                className="w-full bg-surface-2/50 border border-hairline rounded-2xl pl-11 pr-5 py-3 text-sm focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40"
                            />
                        </div>
                        <div className="flex gap-2">
                            {(["viewer", "admin"] as const).map((r) => (
                                <button
                                    key={r}
                                    type="button"
                                    onClick={() => setRole(r)}
                                    className={cn(
                                        "px-4 py-3 rounded-2xl border font-mono text-[10px] uppercase tracking-[0.18em] transition-all flex items-center gap-2",
                                        role === r
                                            ? "bg-accent/15 border-accent/30 text-accent"
                                            : "bg-white/5 border-hairline text-fg-60 hover:text-fg"
                                    )}
                                >
                                    {r === "admin" ? <ShieldCheck className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                                    {roleTag(r)}
                                </button>
                            ))}
                        </div>
                        <button
                            onClick={handleInvite}
                            disabled={!!acting || !email.trim()}
                            className="px-6 py-3 rounded-2xl bg-accent/15 border border-accent/30 text-accent font-mono text-[10px] uppercase tracking-[0.18em] hover:bg-accent/25 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                        >
                            {acting === "invite" ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
                            {t("inviteButton")}
                        </button>
                    </div>
                    <div className="space-y-1">
                        <p className="text-[11px] text-fg-40">{role === "admin" ? t("roleAdminHint") : t("roleViewerHint")}</p>
                        <p className="text-[11px] text-accent-hot">{t("inviteFree", { free: freeSeats })}</p>
                    </div>
                </motion.div>
            )}

            {/* Seats: the owner, then every seat the account owns, then the locked one */}
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="glass rounded-[2rem] p-5 sm:p-8">
                <div className="flex flex-wrap items-center gap-2 mb-5">
                    <Users className="w-4 h-4 text-fg-40" />
                    <span className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">{t("membersTitle")}</span>
                    <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.18em] text-fg-40">
                        {(data?.seats?.paid ?? 0) === 0
                            ? t("seatsNone")
                            : t("seatsLine", { paid: data!.seats.paid, free: data!.seats.free })}
                    </span>
                </div>

                <div className="space-y-3">
                    {/* Seat 1: the owner, included */}
                    <div className="flex flex-col sm:flex-row sm:items-center gap-4 px-4 py-4 rounded-2xl border border-hairline bg-surface-2/30">
                        <div className="w-9 h-9 shrink-0 rounded-xl bg-[rgba(2,141,196,0.15)] ring-1 ring-[rgba(2,141,196,0.30)] grid place-items-center">
                            <Crown className="w-4 h-4 text-accent" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium truncate">{data?.owner.label}</p>
                            {data?.owner.email && <p className="text-[11px] text-fg-40 truncate">{data.owner.email}</p>}
                        </div>
                        <span className="px-2 py-0.5 rounded-md font-mono text-[10px] uppercase tracking-[0.22em] border w-fit bg-[rgba(94,234,212,0.10)] text-accent-hot border-[rgba(94,234,212,0.20)]">
                            {t("ownerBadge")}
                        </span>
                    </div>

                    {/* Occupied seats */}
                    {(data?.members ?? []).map((m) => (
                        <div key={m.id} className="flex flex-col sm:flex-row sm:items-center gap-4 px-4 py-4 rounded-2xl border border-hairline bg-surface-2/30">
                            <div className="w-9 h-9 shrink-0 rounded-xl bg-surface-2 border border-hairline grid place-items-center">
                                <UserRound className="w-4 h-4 text-fg-60" />
                            </div>
                            <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium truncate">{m.email}</p>
                                <p className="text-[11px] text-fg-40 font-mono">{t("invitedOn", { date: formatDate(m.created_at) })}</p>
                            </div>

                            <span className={cn(
                                "px-2 py-0.5 rounded-md font-mono text-[10px] uppercase tracking-[0.22em] border w-fit",
                                m.status === "active"
                                    ? "bg-[rgba(94,234,212,0.10)] text-accent-hot border-[rgba(94,234,212,0.20)]"
                                    : "bg-[rgba(245,158,11,0.10)] text-soon border-[rgba(245,158,11,0.20)]"
                            )}>
                                {m.status === "active" ? t("statusActive") : t("statusPending")}
                            </span>

                            {canManage ? (
                                <div className="flex items-center gap-2">
                                    {(["viewer", "admin"] as const).map((r) => (
                                        <button
                                            key={r}
                                            onClick={() => m.role !== r && handleRole(m, r)}
                                            disabled={acting === m.id}
                                            className={cn(
                                                "px-3 py-2 rounded-xl border font-mono text-[10px] uppercase tracking-[0.18em] transition-all disabled:opacity-40",
                                                m.role === r
                                                    ? "bg-accent/15 border-accent/30 text-accent"
                                                    : "bg-white/5 border-hairline text-fg-60 hover:text-fg"
                                            )}
                                        >
                                            {roleTag(r)}
                                        </button>
                                    ))}
                                    <button
                                        onClick={() => handleRemove(m)}
                                        disabled={acting === m.id}
                                        title={t("remove")}
                                        className="p-2 rounded-xl bg-[rgba(244,63,94,0.10)] border border-[rgba(244,63,94,0.20)] text-destructive hover:bg-[rgba(244,63,94,0.18)] transition-all disabled:opacity-40"
                                    >
                                        {acting === m.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                                    </button>
                                </div>
                            ) : (
                                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-fg-40">{roleTag(m.role)}</span>
                            )}
                        </div>
                    ))}

                    {/* Seats already paid for, waiting for someone */}
                    {Array.from({ length: freeSeats }).map((_, i) => (
                        <div key={`free-${i}`} className="flex flex-col sm:flex-row sm:items-center gap-4 px-4 py-4 rounded-2xl border border-dashed border-[rgba(94,234,212,0.30)] bg-[rgba(94,234,212,0.05)]">
                            <div className="w-9 h-9 shrink-0 rounded-xl bg-[rgba(94,234,212,0.10)] border border-[rgba(94,234,212,0.20)] grid place-items-center">
                                <UserPlus className="w-4 h-4 text-accent-hot" />
                            </div>
                            <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium text-accent-hot">{t("seatFree")}</p>
                                <p className="text-[11px] text-fg-40">{t("seatFreeHint")}</p>
                            </div>
                            {canManage && (
                                <button
                                    onClick={() => emailRef.current?.focus()}
                                    className="px-4 py-2 rounded-xl bg-[rgba(94,234,212,0.12)] border border-[rgba(94,234,212,0.28)] text-accent-hot font-mono text-[10px] uppercase tracking-[0.18em] hover:bg-[rgba(94,234,212,0.20)] transition-all"
                                >
                                    {t("inviteButton")}
                                </button>
                            )}
                        </div>
                    ))}

                    {/* The next seat, locked behind its price */}
                    {canManage && (
                        <div className="flex flex-col sm:flex-row sm:items-center gap-4 px-4 py-4 rounded-2xl border border-dashed border-hairline bg-surface-2/20 opacity-70">
                            <div className="w-9 h-9 shrink-0 rounded-xl bg-surface-2 border border-hairline grid place-items-center">
                                <Lock className="w-4 h-4 text-fg-40" />
                            </div>
                            <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium text-fg-40 line-through decoration-fg-40/60">{t("seatLocked")}</p>
                                <p className="text-[11px] text-fg-40">
                                    {data?.can_unlock ? t("seatLockedHint", { amount: priceLabel }) : t("needSubscription")}
                                </p>
                            </div>
                            <button
                                onClick={handleUnlock}
                                disabled={!!acting || !data?.can_unlock}
                                className="px-5 py-2.5 rounded-xl bg-[rgba(245,158,11,0.15)] border border-[rgba(245,158,11,0.30)] text-soon font-mono text-[10px] uppercase tracking-[0.18em] hover:bg-[rgba(245,158,11,0.25)] transition-all flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                {acting === "unlock" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Lock className="w-3.5 h-3.5" />}
                                {t("unlockButton", { amount: priceLabel })}
                            </button>
                        </div>
                    )}
                </div>
            </motion.div>
        </div>
    );
}
