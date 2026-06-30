"use client";

export const runtime = "edge";

import { useState, useEffect, useMemo } from "react";
import { ShieldCheck, User, LogOut, Loader2, Check, X, Search, ArrowUpDown, CalendarDays, HelpCircle, Trash2, ShieldPlus, ShieldOff, Crown, UserCog, Wrench, ChevronDown, Link2, Link2Off, Pencil } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useUser } from "@clerk/nextjs";
import { Link } from "@/i18n/navigation";
import { useTranslations } from "next-intl";

type Role = "hiperadmin" | "superadmin" | "user";

const ROLE_ORDER: Record<Role, number> = { hiperadmin: 3, superadmin: 2, user: 1 };

const RoleBadge = ({ role, t }: { role: Role; t: (k: string) => string }) => {
    const styles: Record<Role, string> = {
        hiperadmin: "bg-[rgba(2,141,196,0.10)] text-accent border-[rgba(2,141,196,0.20)]",
        superadmin: "bg-[rgba(244,63,94,0.10)] text-destructive border-[rgba(244,63,94,0.20)]",
        user: "bg-surface-2 text-fg-40 border-hairline",
    };
    const labels: Record<Role, string> = { hiperadmin: t("roleHiperadmin"), superadmin: t("roleSuperadmin"), user: t("roleUser") };
    return (
        <span className={`px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-widest border ${styles[role]}`}>
            {labels[role]}
        </span>
    );
};

const RoleIcon = ({ role }: { role: Role }) => {
    if (role === "hiperadmin") return <Crown className="w-8 h-8 text-accent" />;
    if (role === "superadmin") return <ShieldCheck className="w-8 h-8 text-destructive" />;
    return <User className="w-8 h-8 text-fg-40" />;
};

/** ISO-3166 alpha-2 → flag emoji. */
const flagEmoji = (cc?: string | null): string => {
    if (!cc || cc.length !== 2) return "";
    const base = 0x1f1e6;
    const up = cc.toUpperCase();
    return String.fromCodePoint(base + up.charCodeAt(0) - 65, base + up.charCodeAt(1) - 65);
};

const hostOf = (url?: string | null): string | null => {
    if (!url) return null;
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
};

export default function SuperadminPage() {
    const t = useTranslations("superadmin");
    const { user: clerkUser } = useUser();
    const [users, setUsers] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [acting, setActing] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [sortOrder, setSortOrder] = useState<"desc" | "asc">("desc");
    const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
    const [callerRole, setCallerRole] = useState<Role>("user");
    const [viewerId, setViewerId] = useState<string | null>(null); // impersonation-aware self ID
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
    const [labelEditing, setLabelEditing] = useState<string | null>(null); // user id being labelled
    const [labelDraft, setLabelDraft] = useState("");

    const toggleGroup = (key: string) => setCollapsed(p => ({ ...p, [key]: !p[key] }));

    useEffect(() => { fetchUsers(); }, []);

    const fetchUsers = async () => {
        setLoading(true);
        try {
            const res = await fetch("/api/admin/users");
            const data = await res.json() as any;
            // API returns { users: [...], _viewer_role, _viewer_id }
            const userList = Array.isArray(data) ? data : (data.users || []);
            setUsers(userList);
            setCallerRole((data._viewer_role || "user") as Role);
            setViewerId(data._viewer_id || null);
        } catch (err) { console.error(err); }
        finally { setLoading(false); }
    };

    const filtered = useMemo(() =>
        users
            .filter(u => {
                const q = search.toLowerCase();
                return (
                    u.name?.toLowerCase().includes(q) ||
                    u.email?.toLowerCase().includes(q) ||
                    u.admin_label?.toLowerCase().includes(q) ||
                    u.company_name?.toLowerCase().includes(q) ||
                    u.shopify_domain?.toLowerCase().includes(q) ||
                    u.acq_utm_source?.toLowerCase().includes(q) ||
                    u.acq_referrer?.toLowerCase().includes(q) ||
                    u.acq_country?.toLowerCase().includes(q)
                );
            })
            .sort((a, b) => {
                const dateA = new Date(a.created_at).getTime();
                const dateB = new Date(b.created_at).getTime();
                return sortOrder === "desc" ? dateB - dateA : dateA - dateB;
            }),
        [users, search, sortOrder]
    );

    // Split filtered users into 3 buckets: admins, fully-integrated, no-integration
    const groups = useMemo(() => {
        const admins: any[] = [], integrated: any[] = [], pending: any[] = [];
        for (const u of filtered) {
            const role = u.role as Role;
            if (role === "hiperadmin" || role === "superadmin") admins.push(u);
            else if (u.shopify_authorized && u.ix_authorized) integrated.push(u);
            else pending.push(u);
        }
        return { admins, integrated, pending };
    }, [filtered]);

    const handleImpersonate = async (targetId: string | null) => {
        setActing(targetId || "clear");
        try {
            const res = await fetch("/api/admin/impersonate", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ targetId })
            });
            if (res.ok) window.location.href = "/dashboard";
        } catch (err) { console.error(err); }
        finally { setActing(null); }
    };

    const handleRoleChange = async (targetId: string, newRole: Role) => {
        setActing(targetId);
        try {
            const res = await fetch("/api/admin/users", {
                method: "PATCH", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ targetId, role: newRole })
            });
            if (!res.ok) { const err = await res.json() as any; alert(t("errorPrefix", { error: err.error })); }
            else await fetchUsers();
        } catch (err) { console.error(err); }
        finally { setActing(null); }
    };

    const handleLabelSave = async (targetId: string) => {
        const label = labelDraft.trim();
        setActing(targetId);
        try {
            const res = await fetch("/api/admin/users", {
                method: "PATCH", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ targetId, admin_label: label })
            });
            if (res.ok) {
                setUsers(prev => prev.map(u => u.id === targetId ? { ...u, admin_label: label || null } : u));
                setLabelEditing(null);
            } else { const err = await res.json() as any; alert(t("errorPrefix", { error: err.error })); }
        } catch (err) { console.error(err); }
        finally { setActing(null); }
    };

    const handleDelete = async (targetId: string) => {
        setActing(targetId); setDeleteConfirm(null);
        try {
            const res = await fetch("/api/admin/users", {
                method: "DELETE", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ targetId })
            });
            if (res.ok) setUsers(prev => prev.filter(u => u.id !== targetId));
            else { const err = await res.json() as any; alert(t("errorPrefix", { error: err.error })); }
        } catch (err) { console.error(err); }
        finally { setActing(null); }
    };

    /** What role buttons can the caller show for a target user? */
    const getPromoteOptions = (targetRole: Role): { label: string; role: Role; icon: React.ReactNode }[] => {
        if (callerRole === "hiperadmin") {
            // Hiperadmin can assign any role below hiperadmin
            if (targetRole === "user") return [
                { label: t("roleSuperadmin"), role: "superadmin", icon: <ShieldCheck className="w-3 h-3" /> },
            ];
            if (targetRole === "superadmin") return [
                { label: t("revoke"), role: "user", icon: <ShieldOff className="w-3 h-3" /> },
            ];
        }
        return [];
    };

    const renderUserCard = (user: any) => {
        const isSelf = (viewerId || clerkUser?.id) === user.id;
        const targetRole = user.role as Role;
        const callerLevel = ROLE_ORDER[callerRole] || 1;
        const targetLevel = ROLE_ORDER[targetRole] || 1;
        const canImpersonate = !isSelf && callerLevel > targetLevel;
        const promoteOptions = !isSelf && targetRole !== "hiperadmin" ? getPromoteOptions(targetRole) : [];
        const canDelete = !isSelf && targetRole !== "hiperadmin" &&
            (callerRole === "hiperadmin" || (callerRole === "superadmin" && targetLevel < ROLE_ORDER["superadmin"]));

        // Acquisition origin: utm > referrer host > direct; null = never captured (bot/API signup).
        const acqLabel: string | null = user.acq_utm_source
            ? (user.acq_utm_medium ? `${user.acq_utm_source} / ${user.acq_utm_medium}` : user.acq_utm_source)
            : (hostOf(user.acq_referrer) || (user.acq_captured_at ? t("originDirect") : null));

        return (
            <motion.div
                layout key={user.id}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95, height: 0 }}
                className="glass rounded-[2rem] p-5 sm:p-8 border-hairline hover:border-rule transition-all"
            >
                <div className="flex flex-col lg:flex-row items-center gap-8">
                    {/* Avatar */}
                    <div className="w-16 h-16 rounded-2xl bg-surface-2 border border-hairline flex items-center justify-center shrink-0">
                        <RoleIcon role={targetRole} />
                    </div>

                    {/* Info */}
                    <div className="flex-1 space-y-2 text-center lg:text-left">
                        <div className="flex items-center justify-center lg:justify-start gap-3 flex-wrap">
                            <h2 className="text-xl font-bold">{user.name}</h2>
                            <RoleBadge role={targetRole} t={t} />
                            {isSelf && (
                                <span className="px-2 py-0.5 rounded-md bg-surface-2 text-fg-40 text-[10px] font-black uppercase tracking-widest border border-hairline">{t("yourAccount")}</span>
                            )}
                        </div>
                        {/* Store name (admin_label) — editable, identification only; never fiscal */}
                        {labelEditing === user.id ? (
                            <div className="flex items-center justify-center lg:justify-start gap-1.5">
                                <input
                                    autoFocus value={labelDraft} onChange={e => setLabelDraft(e.target.value)}
                                    onKeyDown={e => { if (e.key === "Enter") handleLabelSave(user.id); if (e.key === "Escape") setLabelEditing(null); }}
                                    placeholder={t("storeLabelPlaceholder")}
                                    className="bg-surface-2/60 border border-hairline rounded-lg px-2.5 py-1 text-sm font-semibold w-52 focus:outline-none focus:border-accent transition-all"
                                />
                                <button onClick={() => handleLabelSave(user.id)} disabled={acting !== null} className="p-1.5 rounded-md bg-[rgba(2,141,196,0.15)] text-accent hover:bg-[rgba(2,141,196,0.25)] transition-all disabled:opacity-30">
                                    {acting === user.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                                </button>
                                <button onClick={() => setLabelEditing(null)} className="p-1.5 rounded-md bg-surface-2 text-fg-40 hover:text-fg transition-all"><X className="w-3.5 h-3.5" /></button>
                            </div>
                        ) : (
                            <button
                                onClick={() => { setLabelEditing(user.id); setLabelDraft(user.admin_label || ""); }}
                                className="group/lbl flex items-center justify-center lg:justify-start gap-2 transition-all"
                            >
                                {user.admin_label
                                    ? <span className="text-base font-bold text-accent">{user.admin_label}</span>
                                    : <span className="text-xs font-bold text-fg-40/70 italic flex items-center gap-1.5 group-hover/lbl:text-accent transition-colors"><Pencil className="w-3 h-3" /> {t("storeLabelAdd")}</span>}
                                {user.admin_label && <Pencil className="w-3 h-3 text-fg-40 opacity-0 group-hover/lbl:opacity-60 transition-opacity" />}
                            </button>
                        )}
                        <div className="flex flex-col gap-1.5">
                            <p className="text-fg-40 text-sm font-medium">{user.email}</p>
                            <div className="flex items-center justify-center lg:justify-start gap-2 text-[10px] font-black text-fg-40 uppercase tracking-widest">
                                <CalendarDays className="w-3 h-3 text-destructive/60" />
                                {t("joined", { date: new Date(user.created_at).toLocaleDateString("pt-PT") })}
                            </div>
                        </div>
                    </div>

                    {/* Fiscal Data */}
                    <div className="flex flex-col gap-3 w-full lg:w-auto lg:px-10 lg:border-x lg:border-hairline lg:min-w-[200px]">
                        <span className="text-[10px] font-black text-fg-40 uppercase tracking-widest leading-none">{t("fiscalData")}</span>
                        {user.registration_completed ? (
                            <div className="space-y-1">
                                <p className="text-xs font-bold text-fg flex items-center gap-2">
                                    <ShieldCheck className="w-3 h-3 text-accent" /> {user.nif}
                                </p>
                                {user.company_name && (
                                    <p className="text-[10px] text-fg-40 font-bold uppercase truncate max-w-[150px]">{user.company_name}</p>
                                )}
                                <p className="text-[10px] text-fg-40 font-medium truncate max-w-[150px]">{user.fiscal_address}</p>
                            </div>
                        ) : (
                            <span className="text-[10px] font-black text-soon/50 uppercase tracking-widest italic">{t("registrationPending")}</span>
                        )}
                    </div>

                    {/* Status */}
                    <div className="flex flex-wrap items-center justify-center gap-6 w-full lg:w-auto lg:pr-10 lg:border-r lg:border-hairline">
                        <div className="flex flex-col items-center gap-1.5">
                            <span className="text-[10px] font-black text-fg-40 uppercase tracking-widest leading-none">{t("status")}</span>
                            <div className="flex items-center gap-4">
                                {[t("shopify"), t("ixApi")].map((label, i) => {
                                    const ok = i === 0 ? user.shopify_authorized : user.ix_authorized;
                                    const err = i === 0 ? user.shopify_error : user.ix_error;
                                    return (
                                        <div key={label} className="flex flex-col items-center group/tip relative">
                                            <span className="text-[10px] font-black text-fg-40 uppercase mb-1 opacity-50">{label}</span>
                                            {ok ? <div className="text-accent-hot text-[10px] font-bold">● OK</div>
                                                : <div className="text-soon text-[10px] font-bold flex items-center gap-1">
                                                    ● {(i === 0 ? user.shopify_domain : true) ? "ERR" : "OFF"}
                                                    {err && <HelpCircle className="w-2.5 h-2.5 opacity-50" />}
                                                </div>}
                                            {err && <div className="absolute bottom-full mb-2 w-48 p-3 bg-surface-2 border border-hairline rounded-xl shadow-2xl opacity-0 group-hover/tip:opacity-100 transition-all pointer-events-none z-50">
                                                <p className="text-[10px] text-soon/80 font-medium leading-tight">{err}</p>
                                            </div>}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                        <div className="flex flex-col items-center gap-1.5">
                            <span className="text-[10px] font-black text-fg-40 uppercase tracking-widest leading-none">{t("domain")}</span>
                            <span className="text-xs font-bold text-fg">{user.shopify_domain || "---"}</span>
                            {/* Admin store label — identification only, never fiscal */}
                            {labelEditing === user.id ? (
                                <div className="flex items-center gap-1 mt-0.5">
                                    <input
                                        autoFocus value={labelDraft} onChange={e => setLabelDraft(e.target.value)}
                                        onKeyDown={e => { if (e.key === "Enter") handleLabelSave(user.id); if (e.key === "Escape") setLabelEditing(null); }}
                                        placeholder={t("storeLabelPlaceholder")}
                                        className="bg-surface-2/60 border border-hairline rounded-lg px-2 py-1 text-[11px] w-32 focus:outline-none focus:border-accent transition-all"
                                    />
                                    <button onClick={() => handleLabelSave(user.id)} disabled={acting !== null} className="p-1 rounded-md bg-[rgba(2,141,196,0.15)] text-accent hover:bg-[rgba(2,141,196,0.25)] transition-all disabled:opacity-30">
                                        {acting === user.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                                    </button>
                                    <button onClick={() => setLabelEditing(null)} className="p-1 rounded-md bg-surface-2 text-fg-40 hover:text-fg transition-all"><X className="w-3 h-3" /></button>
                                </div>
                            ) : (
                                <button
                                    onClick={() => { setLabelEditing(user.id); setLabelDraft(user.admin_label || ""); }}
                                    className="group/lbl flex items-center gap-1.5 mt-0.5 transition-all"
                                >
                                    {user.admin_label
                                        ? <span className="text-[11px] font-black text-accent uppercase tracking-wider">{user.admin_label}</span>
                                        : <span className="text-[10px] font-bold text-fg-40/50 italic">{t("storeLabelAdd")}</span>}
                                    <Pencil className="w-2.5 h-2.5 text-fg-40 opacity-0 group-hover/lbl:opacity-60 transition-opacity" />
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Acquisition origin */}
                    <div className="flex flex-col items-center gap-1.5 w-full lg:w-auto lg:pr-10 lg:border-r lg:border-hairline lg:min-w-[140px]">
                        <span className="text-[10px] font-black text-fg-40 uppercase tracking-widest leading-none">{t("origin")}</span>
                        {acqLabel ? (
                            <div className="flex flex-col items-center gap-0.5">
                                <span className="text-xs font-bold text-fg truncate max-w-[140px]">{acqLabel}</span>
                                {user.acq_country && (
                                    <span className="text-[10px] text-fg-40 font-bold">{flagEmoji(user.acq_country)} {user.acq_country}</span>
                                )}
                            </div>
                        ) : (
                            <span className="text-[10px] font-black text-soon/60 uppercase tracking-widest italic">{t("originNone")}</span>
                        )}
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2 flex-wrap justify-center">
                        {canImpersonate && (
                            <button onClick={() => handleImpersonate(user.id)} disabled={acting !== null}
                                className="bg-white text-black px-5 py-3 rounded-2xl font-black text-[10px] uppercase tracking-widest flex items-center gap-2 hover:bg-destructive hover:text-fg transition-all duration-300 active:scale-95 disabled:opacity-30">
                                {acting === user.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserCog className="w-3 h-3" />}
                                {t("impersonate")}
                            </button>
                        )}

                        {!isSelf && (
                            <Link href={`/superadmin/users/${user.id}/dev-mode`}
                                className="bg-[rgba(2,141,196,0.10)] text-accent border border-[rgba(2,141,196,0.20)] px-4 py-3 rounded-2xl font-mono text-[10px] uppercase tracking-[0.18em] flex items-center gap-2 hover:bg-[rgba(2,141,196,0.18)] transition-all active:scale-95">
                                <Wrench className="w-3 h-3" /> {t("devMode")}
                            </Link>
                        )}

                        {/* Role change buttons */}
                        {promoteOptions.map(opt => (
                            <button key={opt.role} onClick={() => handleRoleChange(user.id, opt.role)}
                                disabled={acting !== null}
                                className="px-4 py-3 rounded-2xl font-black text-[10px] uppercase tracking-widest flex items-center gap-2 bg-[rgba(245,158,11,0.10)] text-soon border border-[rgba(245,158,11,0.20)] hover:bg-[rgba(245,158,11,0.18)] transition-all disabled:opacity-30">
                                {acting === user.id ? <Loader2 className="w-3 h-3 animate-spin" /> : opt.icon}
                                {opt.label}
                            </button>
                        ))}

                        {/* Delete */}
                        {canDelete && (
                            deleteConfirm === user.id ? (
                                <div className="flex items-center gap-2 bg-[rgba(244,63,94,0.10)] border border-[rgba(244,63,94,0.20)] rounded-2xl px-4 py-2">
                                    <span className="text-[10px] font-black text-destructive uppercase tracking-wider">{t("confirmQuestion")}</span>
                                    <button onClick={() => handleDelete(user.id)} className="p-1 rounded-lg bg-destructive text-white hover:bg-destructive/85 transition-all"><Check className="w-3 h-3" /></button>
                                    <button onClick={() => setDeleteConfirm(null)} className="p-1 rounded-lg bg-surface-2 text-fg-60 hover:bg-surface-2/70 transition-all"><X className="w-3 h-3" /></button>
                                </div>
                            ) : (
                                <button onClick={() => setDeleteConfirm(user.id)} disabled={acting !== null}
                                    className="px-3 py-3 rounded-2xl flex items-center gap-2 bg-[rgba(244,63,94,0.05)] text-destructive/50 border border-[rgba(244,63,94,0.10)] hover:bg-[rgba(244,63,94,0.10)] hover:text-destructive hover:border-[rgba(244,63,94,0.20)] transition-all disabled:opacity-30">
                                    <Trash2 className="w-3.5 h-3.5" />
                                </button>
                            )
                        )}
                    </div>
                </div>
            </motion.div>
        );
    };

    if (loading) return (
        <div className="min-h-[60vh] flex items-center justify-center">
            <Loader2 className="w-12 h-12 text-destructive animate-spin opacity-50" />
        </div>
    );

    return (
        <div className="space-y-12 animate-in fade-in duration-1000 slide-in-from-bottom-4">
            {/* Header */}
            <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-8">
                <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-3">
                        <ShieldCheck className="w-8 h-8 text-destructive" />
                        <h1 className="text-3xl sm:text-4xl lg:text-5xl font-black tracking-tight bg-gradient-to-r from-fg via-fg to-fg-40 bg-clip-text text-transparent">
                            {t("title")}
                        </h1>
                    </div>
                    <p className="text-fg-60 font-semibold tracking-wide">
                        {t("subtitleLead")} <RoleBadge role={callerRole} t={t} />
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-4">
                    <div className="relative group">
                        <Search className="w-4 h-4 text-fg-40 absolute left-4 top-1/2 -translate-y-1/2 group-focus-within:text-destructive transition-colors" />
                        <input
                            type="text" placeholder={t("searchPlaceholder")}
                            value={search} onChange={e => setSearch(e.target.value)}
                            className="bg-surface-2/50 border border-hairline rounded-2xl py-3 pl-12 pr-6 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-[rgba(244,63,94,0.20)] focus:border-[rgba(244,63,94,0.40)] w-full lg:w-80 transition-all"
                        />
                    </div>
                    <button
                        onClick={() => setSortOrder(p => p === "desc" ? "asc" : "desc")}
                        className="bg-surface-2/50 border border-hairline rounded-2xl px-5 py-3 text-xs font-black uppercase tracking-widest flex items-center gap-3 hover:bg-surface-2/80 transition-all active:scale-95"
                    >
                        <ArrowUpDown className="w-4 h-4 text-destructive" />
                        {sortOrder === "desc" ? t("sortNewer") : t("sortOlder")}
                    </button>
                </div>
            </div>

            <div className="text-[10px] font-black uppercase tracking-[0.2em] text-fg-40 border-b border-hairline pb-4 flex justify-between">
                <span>{t("showing", { filtered: filtered.length, total: users.length })}</span>
                <span>{t("database")}</span>
            </div>

            <div className="space-y-10">
                {([
                    { key: "admins", label: t("groupAdmins"), icon: <ShieldCheck className="w-4 h-4 text-destructive" />, list: groups.admins },
                    { key: "integrated", label: t("groupIntegrated"), icon: <Link2 className="w-4 h-4 text-accent-hot" />, list: groups.integrated },
                    { key: "pending", label: t("groupPending"), icon: <Link2Off className="w-4 h-4 text-soon" />, list: groups.pending },
                ] as const).map(sec => {
                    const isOpen = !collapsed[sec.key];
                    return (
                        <section key={sec.key} className="space-y-6">
                            {/* Group header — click to collapse */}
                            <button
                                onClick={() => toggleGroup(sec.key)}
                                className="w-full flex items-center justify-between gap-4 px-5 py-4 rounded-2xl bg-surface-2/40 border border-hairline hover:bg-surface-2/70 transition-all"
                            >
                                <div className="flex items-center gap-3">
                                    {sec.icon}
                                    <span className="text-xs font-black uppercase tracking-[0.2em] text-fg">{sec.label}</span>
                                    <span className="px-2 py-0.5 rounded-md bg-surface-2 text-fg-40 text-[10px] font-black tracking-widest border border-hairline">{sec.list.length}</span>
                                </div>
                                <ChevronDown className={`w-4 h-4 text-fg-40 transition-transform ${isOpen ? "" : "-rotate-90"}`} />
                            </button>

                            <AnimatePresence initial={false}>
                                {isOpen && (
                                    <motion.div
                                        key="body"
                                        initial={{ opacity: 0, height: 0 }}
                                        animate={{ opacity: 1, height: "auto" }}
                                        exit={{ opacity: 0, height: 0 }}
                                        className="overflow-hidden"
                                    >
                                        {sec.list.length === 0 ? (
                                            <p className="text-[10px] font-black uppercase tracking-widest text-fg-40 italic px-5 py-6">{t("groupEmpty")}</p>
                                        ) : (
                                            <div className="grid gap-6">
                                                <AnimatePresence mode="popLayout">
                                                    {sec.list.map(renderUserCard)}
                                                </AnimatePresence>
                                            </div>
                                        )}
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </section>
                    );
                })}
            </div>

            <div className="pt-10 flex justify-center">
                <button onClick={() => handleImpersonate(null)}
                    className="flex items-center gap-2 text-fg-40 hover:text-fg text-[10px] font-black uppercase tracking-[0.2em] transition-all py-4 px-5 sm:px-8 border border-hairline rounded-2xl hover:bg-white/5">
                    <LogOut className="w-4 h-4" />
                    {t("clearImpersonation")}
                </button>
            </div>
        </div>
    );
}
