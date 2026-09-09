"use client";

export const runtime = "edge";

import { useState, useEffect, useMemo } from "react";
import { ShieldCheck, User, LogOut, Loader2, Check, X, Search, ArrowUpDown, CalendarDays, HelpCircle, Trash2, ShieldOff, Crown, UserCog, Wrench, ChevronDown, Link2, Link2Off, Pencil, Eye, Moon, Mail, Filter } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useUser } from "@clerk/nextjs";
import { Link } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { kindLabel } from "@/lib/connection-kinds";

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

/**
 * Each platform in its own colour, so a card says what it IS before it is read.
 * A Stripe pipe and a Shopify pipe on the same account are otherwise identical
 * at a glance — which is how one used to be mistaken for the other.
 */
const PLATFORM_PILL: Record<string, string> = {
    shopify: "bg-[rgba(149,191,71,0.14)] text-[#a3cc55] border-[rgba(149,191,71,0.32)]",
    stripe: "bg-[rgba(168,85,247,0.16)] text-purple-400 border-[rgba(168,85,247,0.36)]",
    lodgify: "bg-[rgba(2,141,196,0.14)] text-accent border-[rgba(2,141,196,0.30)]",
    eupago: "bg-[rgba(245,158,11,0.14)] text-soon border-[rgba(245,158,11,0.30)]",
    invoicexpress: "bg-[rgba(6,95,70,0.35)] text-emerald-300 border-[rgba(6,95,70,0.70)]",
    moloni: "bg-[rgba(59,130,246,0.14)] text-blue-400 border-[rgba(59,130,246,0.32)]",
    vendus: "bg-[rgba(236,72,153,0.14)] text-pink-400 border-[rgba(236,72,153,0.32)]",
};

const SHORT_LABEL: Record<string, string> = { invoicexpress: "IX" };

function PlatformPill({ kind }: { kind: string }) {
    const style = PLATFORM_PILL[kind] ?? "bg-surface-2 text-fg-40 border-hairline";
    return (
        <span className={`px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-widest border ${style}`}>
            {SHORT_LABEL[kind] ?? kindLabel(kind)}
        </span>
    );
}

/** ISO-3166 alpha-2 -> flag emoji. */
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

const dateOf = (v?: string | null): string | null => {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("pt-PT");
};

/**
 * The four answers that matter operationally: is this client paying, inside a
 * free window, refused by the gate, or exempt. `sub_state` comes from the API,
 * which computes it with the same subscriptionUIState the worker gate uses — so
 * a badge here can never disagree with what the worker does to their invoices.
 */
type SubBucket = "all" | "active" | "trialing" | "blocked" | "exempt";

function subBucket(state?: string): Exclude<SubBucket, "all"> {
    if (state === "active") return "active";
    if (state === "exempt") return "exempt";
    if (state === "trialing" || state === "trialing_earlybird") return "trialing";
    return "blocked";
}

function SubBadge({ state, t }: { state?: string; t: any }) {
    const bucket = subBucket(state);
    const style = {
        active: "bg-[rgba(16,185,129,0.15)] text-emerald-400 border-[rgba(16,185,129,0.30)]",
        trialing: "bg-[rgba(234,179,8,0.15)] text-yellow-400 border-[rgba(234,179,8,0.30)]",
        blocked: "bg-[rgba(244,63,94,0.15)] text-destructive border-[rgba(244,63,94,0.30)]",
        exempt: "bg-[rgba(168,85,247,0.15)] text-purple-400 border-[rgba(168,85,247,0.30)]",
    }[bucket];
    const label = {
        active: t("subActive"), trialing: t("subTrial"),
        blocked: t("subBlocked"), exempt: t("subExempt"),
    }[bucket];
    return (
        <span className={`px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-widest border ${style}`}>
            {label}
        </span>
    );
}

type SortKey = "joined" | "name" | "seen";

export default function SuperadminPage() {
    const t = useTranslations("superadmin");
    const { user: clerkUser } = useUser();
    const [entries, setEntries] = useState<any[]>([]);
    const [invites, setInvites] = useState<any[]>([]);
    const [accountCount, setAccountCount] = useState(0);
    const [loading, setLoading] = useState(true);
    const [acting, setActing] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [sortOrder, setSortOrder] = useState<"desc" | "asc">("desc");
    const [sortKey, setSortKey] = useState<SortKey>("joined");
    const [subFilter, setSubFilter] = useState<SubBucket>("all");
    const [sourceFilter, setSourceFilter] = useState<string>("all");
    const [destFilter, setDestFilter] = useState<string>("all");
    const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
    const [callerRole, setCallerRole] = useState<Role>("user");
    const [viewerId, setViewerId] = useState<string | null>(null); // impersonation-aware self ID
    // Administrators are the group an operator almost never needs: closed until asked for.
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ admins: true });
    const [labelEditing, setLabelEditing] = useState<string | null>(null); // entry_id being labelled
    const [labelDraft, setLabelDraft] = useState("");

    const toggleGroup = (key: string) => setCollapsed(p => ({ ...p, [key]: !p[key] }));

    useEffect(() => { fetchUsers(); }, []);

    const fetchUsers = async () => {
        setLoading(true);
        try {
            const res = await fetch("/api/admin/users");
            const data = await res.json() as any;
            // API returns { users: [...entries], invites, accounts, _viewer_role, _viewer_id }
            const list = Array.isArray(data) ? data : (data.users || []);
            setEntries(list);
            setInvites(data.invites || []);
            setAccountCount(data.accounts ?? new Set(list.map((e: any) => e.id)).size);
            setCallerRole((data._viewer_role || "user") as Role);
            setViewerId(data._viewer_id || null);
        } catch (err) { console.error(err); }
        finally { setLoading(false); }
    };

    /** Impersonating = the API answers as somebody other than the signed-in admin. */
    const spectating = !!(viewerId && clerkUser?.id && viewerId !== clerkUser.id);

    /** The name to show for an account anywhere it is referenced (invites). */
    const accountNames = useMemo(() => {
        const map = new Map<string, string>();
        for (const e of entries) {
            if (!map.has(e.id)) map.set(e.id, e.entry_label || e.account_label || e.name || e.email);
        }
        return map;
    }, [entries]);

    /** The account's platform pills, for an invite card. */
    const accountPlatforms = useMemo(() => {
        const map = new Map<string, string[]>();
        for (const e of entries) {
            if (!e.source && !e.destination) continue;
            const list = map.get(e.id) ?? [];
            for (const k of [e.source, e.destination]) if (k && !list.includes(k)) list.push(k);
            map.set(e.id, list);
        }
        return map;
    }, [entries]);

    /** Delete removes the ACCOUNT, so it is offered once — on its first card. */
    const primaryEntryIds = useMemo(() => {
        const seen = new Set<string>(), ids = new Set<string>();
        for (const e of entries) {
            if (!seen.has(e.id)) { seen.add(e.id); ids.add(e.entry_id); }
        }
        return ids;
    }, [entries]);

    const sources = useMemo(
        () => [...new Set(entries.map(e => e.source).filter(Boolean))] as string[],
        [entries]);
    const destinations = useMemo(
        () => [...new Set(entries.map(e => e.destination).filter(Boolean))] as string[],
        [entries]);

    const filtered = useMemo(() =>
        entries
            .filter(u => {
                const q = search.toLowerCase();
                return (
                    u.name?.toLowerCase().includes(q) ||
                    u.email?.toLowerCase().includes(q) ||
                    u.entry_label?.toLowerCase().includes(q) ||
                    u.admin_label?.toLowerCase().includes(q) ||
                    u.company_name?.toLowerCase().includes(q) ||
                    u.identifier?.toLowerCase().includes(q) ||
                    u.acq_utm_source?.toLowerCase().includes(q) ||
                    u.acq_referrer?.toLowerCase().includes(q) ||
                    u.acq_country?.toLowerCase().includes(q)
                );
            })
            // An invited extra user works inside somebody else's account: they
            // have no integration of their own and never will, so listing them
            // under "No Integration" reads as twelve broken shops. Their card is
            // the Invited group. A member who somehow owns a pipe still shows.
            .filter(u => !(u.member_of_id && !u.connection_key))
            .filter(u => subFilter === "all" || subBucket(u.sub_state) === subFilter)
            .filter(u => sourceFilter === "all" || u.source === sourceFilter)
            .filter(u => destFilter === "all" || u.destination === destFilter)
            .sort((a, b) => {
                let cmp: number;
                if (sortKey === "name") {
                    cmp = String(a.entry_label || a.account_label || a.name || "")
                        .localeCompare(String(b.entry_label || b.account_label || b.name || ""));
                } else {
                    const field = sortKey === "seen" ? "last_login" : "created_at";
                    cmp = new Date(a[field] ?? 0).getTime() - new Date(b[field] ?? 0).getTime();
                }
                return sortOrder === "desc" ? -cmp : cmp;
            }),
        [entries, search, sortOrder, sortKey, subFilter, sourceFilter, destFilter]
    );

    // Groups: admins, fully-integrated, no-integration, dormant-by-decision.
    const groups = useMemo(() => {
        const admins: any[] = [], integrated: any[] = [], pending: any[] = [], inactive: any[] = [];
        for (const u of filtered) {
            const role = u.role as Role;
            // Inactive wins over everything: it is a decision about the account,
            // and an inactive shop sitting in "Full Integration" is what made us
            // chase alerts for clients we had already parked.
            if (u.is_inactive) inactive.push(u);
            else if (role === "hiperadmin" || role === "superadmin") admins.push(u);
            else if (u.integrated) integrated.push(u);
            else pending.push(u);
        }
        return { admins, integrated, pending, inactive };
    }, [filtered]);

    const visibleInvites = useMemo(() => {
        const q = search.toLowerCase();
        return invites.filter(i =>
            !q ||
            i.email?.toLowerCase().includes(q) ||
            i.member_name?.toLowerCase().includes(q) ||
            (accountNames.get(i.account_id) ?? "").toLowerCase().includes(q)
        );
    }, [invites, search, accountNames]);

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

    /** Save the label of ONE pipe. A connection names itself; the legacy Shopify
     *  pipe still names the account, which is what every other page reads. */
    const handleLabelSave = async (entry: any) => {
        const label = labelDraft.trim();
        setActing(entry.entry_id);
        try {
            const res = await fetch("/api/admin/users", {
                method: "PATCH", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    targetId: entry.id,
                    connectionId: entry.connection_id ?? null,
                    admin_label: label,
                })
            });
            if (res.ok) {
                setEntries(prev => prev.map(e => {
                    if (e.entry_id === entry.entry_id) return { ...e, entry_label: label || null };
                    // The account label is shared by the legacy pipe and by every
                    // card that has no label of its own.
                    if (!entry.connection_id && e.id === entry.id && e.label_scope === "account") {
                        return { ...e, entry_label: label || null, admin_label: label || null };
                    }
                    return e;
                }));
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
            if (res.ok) setEntries(prev => prev.filter(e => e.id !== targetId));
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

    /** One endpoint's status, as the card prints it. */
    const StatusDot = ({ label, ok, err, off }: { label: string; ok: boolean; err?: string | null; off?: boolean }) => (
        <div className="flex flex-col items-center group/tip relative">
            <span className="text-[10px] font-black text-fg-40 uppercase mb-1 opacity-50">{label}</span>
            {ok ? <div className="text-accent-hot text-[10px] font-bold">● OK</div>
                : <div className="text-soon text-[10px] font-bold flex items-center gap-1">
                    ● {off ? "OFF" : "ERR"}
                    {err && <HelpCircle className="w-2.5 h-2.5 opacity-50" />}
                </div>}
            {err && <div className="absolute bottom-full mb-2 w-48 p-3 bg-surface-2 border border-hairline rounded-xl shadow-2xl opacity-0 group-hover/tip:opacity-100 transition-all pointer-events-none z-50">
                <p className="text-[10px] text-soon/80 font-medium leading-tight">{err}</p>
            </div>}
        </div>
    );

    const renderUserCard = (user: any) => {
        const isSelf = (clerkUser?.id ?? viewerId) === user.id;
        const isSpectated = spectating && viewerId === user.id;
        const targetRole = user.role as Role;
        const callerLevel = ROLE_ORDER[callerRole] || 1;
        const targetLevel = ROLE_ORDER[targetRole] || 1;
        const canImpersonate = !isSelf && !isSpectated && callerLevel > targetLevel;
        const promoteOptions = !isSelf && targetRole !== "hiperadmin" ? getPromoteOptions(targetRole) : [];
        const canDelete = !isSelf && targetRole !== "hiperadmin" && primaryEntryIds.has(user.entry_id) &&
            (callerRole === "hiperadmin" || (callerRole === "superadmin" && targetLevel < ROLE_ORDER["superadmin"]));

        const label = user.entry_label || user.admin_label;

        // Acquisition origin: utm > referrer host > direct; null = never captured (bot/API signup).
        const acqLabel: string | null = user.acq_utm_source
            ? (user.acq_utm_medium ? `${user.acq_utm_source} / ${user.acq_utm_medium}` : user.acq_utm_source)
            : (hostOf(user.acq_referrer) || (user.acq_captured_at ? t("originDirect") : null));

        return (
            <motion.div
                layout key={user.entry_id}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95, height: 0 }}
                className={`glass rounded-[2rem] p-5 sm:p-8 border-hairline hover:border-rule transition-all ${user.is_inactive ? "opacity-60" : ""}`}
            >
                <div className="flex flex-col lg:flex-row items-center gap-8">
                    {/* Avatar */}
                    <div className="w-16 h-16 rounded-2xl bg-surface-2 border border-hairline flex items-center justify-center shrink-0">
                        <RoleIcon role={targetRole} />
                    </div>

                    {/* Info */}
                    <div className="flex-1 space-y-2 text-center lg:text-left">
                        <div className="flex items-center justify-center lg:justify-start gap-3 flex-wrap">
                            {/* The headline is the name an operator gave this
                                pipe when there is one: a Clerk profile called
                                "User" identifies nothing. It is also the thing
                                you click to rename — the edit used to hang off
                                a muted line underneath, so clicking the name
                                selected text and did nothing else. */}
                            {labelEditing === user.entry_id ? (
                                <span className="flex items-center gap-1.5">
                                    <input
                                        autoFocus value={labelDraft} onChange={e => setLabelDraft(e.target.value)}
                                        onKeyDown={e => { if (e.key === "Enter") handleLabelSave(user); if (e.key === "Escape") setLabelEditing(null); }}
                                        placeholder={t("storeLabelPlaceholder")}
                                        className="bg-surface-2/60 border border-hairline rounded-lg px-2.5 py-1 text-lg font-bold w-56 focus:outline-none focus:border-accent transition-all"
                                    />
                                    <button onClick={() => handleLabelSave(user)} disabled={acting !== null} className="p-1.5 rounded-md bg-[rgba(2,141,196,0.15)] text-accent hover:bg-[rgba(2,141,196,0.25)] transition-all disabled:opacity-30">
                                        {acting === user.entry_id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                                    </button>
                                    <button onClick={() => setLabelEditing(null)} className="p-1.5 rounded-md bg-surface-2 text-fg-40 hover:text-fg transition-all"><X className="w-3.5 h-3.5" /></button>
                                </span>
                            ) : (
                                <button
                                    onClick={() => { setLabelEditing(user.entry_id); setLabelDraft(label || ""); }}
                                    title={t("storeLabelEdit")}
                                    className="group/lbl flex items-center gap-2 transition-all"
                                >
                                    <h2 className="text-xl font-bold group-hover/lbl:text-accent transition-colors">{label || user.name}</h2>
                                    <Pencil className="w-3.5 h-3.5 text-fg-40 opacity-40 group-hover/lbl:opacity-100 group-hover/lbl:text-accent transition-all" />
                                </button>
                            )}
                            <RoleBadge role={targetRole} t={t} />
                            <SubBadge state={user.sub_state} t={t} />
                            {/* The pipe this card IS: payment platform, then invoicing software. */}
                            {user.source && <PlatformPill kind={user.source} />}
                            {user.destination && <PlatformPill kind={user.destination} />}
                            {user.is_inactive && (
                                <span className="px-2 py-0.5 rounded-md bg-surface-2 text-fg-40 text-[10px] font-black uppercase tracking-widest border border-hairline flex items-center gap-1">
                                    <Moon className="w-2.5 h-2.5" /> {t("inactive")}
                                </span>
                            )}
                            {/* An invited extra user is not an account of its own:
                                say whose account they work in, so the missing
                                subscription does not read as a broken shop. */}
                            {user.member_of_label && (
                                <span className="px-2 py-0.5 rounded-md bg-[rgba(2,141,196,0.12)] text-accent text-[10px] font-black uppercase tracking-widest border border-[rgba(2,141,196,0.28)]">
                                    {user.member_role === "admin" ? "admin" : "read-only"} · {user.member_of_label}
                                </span>
                            )}
                            {isSpectated && (
                                <span className="px-2 py-0.5 rounded-md bg-[rgba(168,85,247,0.15)] text-purple-400 text-[10px] font-black uppercase tracking-widest border border-[rgba(168,85,247,0.30)] flex items-center gap-1">
                                    <Eye className="w-2.5 h-2.5" /> {t("spectating")}
                                </span>
                            )}
                            {isSelf && !isSpectated && (
                                <span className="px-2 py-0.5 rounded-md bg-surface-2 text-fg-40 text-[10px] font-black uppercase tracking-widest border border-hairline">{t("yourAccount")}</span>
                            )}
                        </div>
                        {/* Whose profile sits behind the name, when the name is
                            not theirs. Caption, not control: the control is the
                            headline above. */}
                        {label && label !== user.name && (
                            <p className="text-xs font-bold text-fg-40 uppercase tracking-widest">{user.name}</p>
                        )}
                        <div className="flex flex-col gap-1.5">
                            <p className="text-fg-40 text-sm font-medium">{user.email}</p>
                            <div className="flex items-center justify-center lg:justify-start gap-2 text-[10px] font-black text-fg-40 uppercase tracking-widest">
                                <CalendarDays className="w-3 h-3 text-destructive/60" />
                                {t("joined", { date: dateOf(user.created_at) ?? "—" })}
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

                    {/* Status — ONLY the two platforms this card is about. */}
                    <div className="flex flex-wrap items-center justify-center gap-6 w-full lg:w-auto lg:pr-10 lg:border-r lg:border-hairline">
                        <div className="flex flex-col items-center gap-1.5">
                            <span className="text-[10px] font-black text-fg-40 uppercase tracking-widest leading-none">{t("status")}</span>
                            <div className="flex items-center gap-4">
                                {user.source ? (
                                    <>
                                        <StatusDot label={kindLabel(user.source)} ok={user.source_ok} err={user.source_err} off={user.source_off} />
                                        <StatusDot label={kindLabel(user.destination)} ok={user.dest_ok} err={user.dest_err} off={user.dest_off} />
                                    </>
                                ) : (
                                    <div className="text-soon/60 text-[10px] font-bold">● OFF</div>
                                )}
                            </div>
                            {user.conn_status && user.conn_status !== "active" && (
                                <span className="text-[9px] font-black uppercase tracking-widest text-soon/70">{user.conn_status}</span>
                            )}
                        </div>
                        {user.identifier && (
                            <div className="flex flex-col items-center gap-1.5 max-w-[220px]">
                                <span className="text-[10px] font-black text-fg-40 uppercase tracking-widest leading-none">
                                    {user.identifier_kind === "stripe_account" ? t("stripeAccount") : t("domain")}
                                </span>
                                {/* Full id, never elided: a truncated acct_ is unusable. */}
                                <span className={`text-xs font-bold text-fg text-center ${user.identifier_kind === "stripe_account" ? "font-mono text-[10px] break-all" : ""}`}>
                                    {user.identifier}
                                </span>
                            </div>
                        )}
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
                            deleteConfirm === user.entry_id ? (
                                <div className="flex items-center gap-2 bg-[rgba(244,63,94,0.10)] border border-[rgba(244,63,94,0.20)] rounded-2xl px-4 py-2">
                                    <span className="text-[10px] font-black text-destructive uppercase tracking-wider">{t("confirmQuestion")}</span>
                                    <button onClick={() => handleDelete(user.id)} className="p-1 rounded-lg bg-destructive text-white hover:bg-destructive/85 transition-all"><Check className="w-3 h-3" /></button>
                                    <button onClick={() => setDeleteConfirm(null)} className="p-1 rounded-lg bg-surface-2 text-fg-60 hover:bg-surface-2/70 transition-all"><X className="w-3 h-3" /></button>
                                </div>
                            ) : (
                                <button onClick={() => setDeleteConfirm(user.entry_id)} disabled={acting !== null}
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

    /**
     * An invited extra user. Not an account: the seat belongs to somebody else's
     * store, and the only questions worth answering are whose store, whether the
     * seat was paid for, and whether they ever actually showed up.
     */
    const renderInviteCard = (inv: any) => {
        const store = accountNames.get(inv.account_id) ?? inv.account_id;
        const platforms = accountPlatforms.get(inv.account_id) ?? [];
        const statusStyle = {
            active: "bg-[rgba(16,185,129,0.15)] text-emerald-400 border-[rgba(16,185,129,0.30)]",
            pending: "bg-[rgba(234,179,8,0.15)] text-yellow-400 border-[rgba(234,179,8,0.30)]",
            revoked: "bg-[rgba(244,63,94,0.15)] text-destructive border-[rgba(244,63,94,0.30)]",
        }[inv.status as string] ?? "bg-surface-2 text-fg-40 border-hairline";
        const paid = !!inv.seat_paid_at;

        return (
            <motion.div
                layout key={inv.id}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95, height: 0 }}
                className="glass rounded-[2rem] p-5 sm:p-8 border-hairline hover:border-rule transition-all"
            >
                <div className="flex flex-col lg:flex-row items-center gap-8">
                    <div className="w-16 h-16 rounded-2xl bg-surface-2 border border-hairline flex items-center justify-center shrink-0">
                        <Mail className="w-7 h-7 text-fg-40" />
                    </div>

                    <div className="flex-1 space-y-2 text-center lg:text-left">
                        <div className="flex items-center justify-center lg:justify-start gap-3 flex-wrap">
                            <h2 className="text-xl font-bold">{inv.member_name || inv.email}</h2>
                            <span className={`px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-widest border ${statusStyle}`}>
                                {t(`inviteStatus_${inv.status}` as any)}
                            </span>
                            <span className="px-2 py-0.5 rounded-md bg-[rgba(2,141,196,0.12)] text-accent text-[10px] font-black uppercase tracking-widest border border-[rgba(2,141,196,0.28)]">
                                {inv.role === "admin" ? t("inviteRoleAdmin") : t("inviteRoleViewer")}
                            </span>
                            <span className={`px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-widest border ${paid ? "bg-[rgba(16,185,129,0.15)] text-emerald-400 border-[rgba(16,185,129,0.30)]" : "bg-surface-2 text-fg-40 border-hairline"}`}>
                                {paid
                                    ? t("seatPaid", { amount: ((inv.seat_amount_cents ?? 0) / 100).toFixed(2) })
                                    : t("seatFree")}
                            </span>
                            {platforms.map((k: string) => <PlatformPill key={k} kind={k} />)}
                        </div>
                        <p className="text-base font-bold text-accent">{store}</p>
                        <p className="text-fg-40 text-sm font-medium">{inv.email}</p>
                    </div>

                    <div className="flex flex-col gap-2 w-full lg:w-auto lg:px-10 lg:border-x lg:border-hairline lg:min-w-[200px]">
                        <span className="text-[10px] font-black text-fg-40 uppercase tracking-widest leading-none">{t("inviteDates")}</span>
                        <p className="text-[10px] text-fg-40 font-bold uppercase tracking-widest">
                            {t("invitedOn", { date: dateOf(inv.created_at) ?? "—" })}
                        </p>
                        <p className="text-[10px] text-fg-40 font-bold uppercase tracking-widest">
                            {t("joinedOn", { date: dateOf(inv.accepted_at) ?? "—" })}
                        </p>
                        <p className="text-[10px] text-fg-40 font-bold uppercase tracking-widest">
                            {t("lastVisit", { date: dateOf(inv.member_last_login) ?? t("never") })}
                        </p>
                    </div>

                    <div className="flex flex-col items-center gap-1.5 w-full lg:w-auto lg:pr-10 lg:min-w-[160px]">
                        <span className="text-[10px] font-black text-fg-40 uppercase tracking-widest leading-none">{t("invitedBy")}</span>
                        <span className="text-xs font-bold text-fg text-center">
                            {inv.invited_by_name || inv.invited_by_email || "—"}
                        </span>
                    </div>

                    <div className="flex items-center gap-2 flex-wrap justify-center">
                        {/* Impersonation follows the person, Dev Mode follows the
                            account they work in — the tools act on the pipes, and
                            an extra user owns none. */}
                        {inv.member_user_id && inv.member_user_id !== (clerkUser?.id ?? viewerId) && (
                            <button onClick={() => handleImpersonate(inv.member_user_id)} disabled={acting !== null}
                                className="bg-white text-black px-5 py-3 rounded-2xl font-black text-[10px] uppercase tracking-widest flex items-center gap-2 hover:bg-destructive hover:text-fg transition-all duration-300 active:scale-95 disabled:opacity-30">
                                {acting === inv.member_user_id ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserCog className="w-3 h-3" />}
                                {t("impersonate")}
                            </button>
                        )}
                        <Link href={`/superadmin/users/${inv.account_id}/dev-mode`}
                            className="bg-[rgba(2,141,196,0.10)] text-accent border border-[rgba(2,141,196,0.20)] px-4 py-3 rounded-2xl font-mono text-[10px] uppercase tracking-[0.18em] flex items-center gap-2 hover:bg-[rgba(2,141,196,0.18)] transition-all active:scale-95">
                            <Wrench className="w-3 h-3" /> {t("devMode")}
                        </Link>
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

    const selectClass = "bg-surface-2/50 border border-hairline rounded-2xl px-4 py-3 text-[10px] font-black uppercase tracking-widest text-fg focus:outline-none focus:border-[rgba(244,63,94,0.40)] transition-all";

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
                    <div className="flex items-center gap-1.5 bg-surface-2/50 border border-hairline rounded-2xl p-1.5">
                        {([
                            ["all", t("filterAll")],
                            ["active", t("subActive")],
                            ["trialing", t("subTrial")],
                            ["blocked", t("subBlocked")],
                        ] as const).map(([key, label]) => (
                            <button
                                key={key}
                                onClick={() => setSubFilter(key as SubBucket)}
                                className={`px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${subFilter === key ? "bg-destructive/20 text-destructive" : "text-fg-40 hover:text-fg"}`}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {/* Filters and ordering */}
            <div className="flex flex-wrap items-center gap-3">
                <Filter className="w-4 h-4 text-fg-40" />
                <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)} className={selectClass}>
                    <option value="all">{t("filterAllSources")}</option>
                    {sources.map(s => <option key={s} value={s}>{kindLabel(s)}</option>)}
                </select>
                <select value={destFilter} onChange={e => setDestFilter(e.target.value)} className={selectClass}>
                    <option value="all">{t("filterAllDestinations")}</option>
                    {destinations.map(d => <option key={d} value={d}>{kindLabel(d)}</option>)}
                </select>
                <select value={sortKey} onChange={e => setSortKey(e.target.value as SortKey)} className={selectClass}>
                    <option value="joined">{t("sortByJoined")}</option>
                    <option value="seen">{t("sortByLastVisit")}</option>
                    <option value="name">{t("sortByName")}</option>
                </select>
                <button
                    onClick={() => setSortOrder(p => p === "desc" ? "asc" : "desc")}
                    className="bg-surface-2/50 border border-hairline rounded-2xl px-5 py-3 text-xs font-black uppercase tracking-widest flex items-center gap-3 hover:bg-surface-2/80 transition-all active:scale-95"
                >
                    <ArrowUpDown className="w-4 h-4 text-destructive" />
                    {sortOrder === "desc" ? t("sortNewer") : t("sortOlder")}
                </button>
                {(sourceFilter !== "all" || destFilter !== "all" || subFilter !== "all" || search) && (
                    <button
                        onClick={() => { setSourceFilter("all"); setDestFilter("all"); setSubFilter("all"); setSearch(""); }}
                        className="text-[10px] font-black uppercase tracking-widest text-fg-40 hover:text-fg transition-all px-3 py-3"
                    >
                        {t("filterClear")}
                    </button>
                )}
            </div>

            <div className="text-[10px] font-black uppercase tracking-[0.2em] text-fg-40 border-b border-hairline pb-4 flex justify-between">
                <span>{t("showingConnections", { filtered: filtered.length, total: entries.length, accounts: accountCount })}</span>
                <span>{t("database")}</span>
            </div>

            <div className="space-y-10">
                {([
                    { key: "admins", label: t("groupAdmins"), icon: <ShieldCheck className="w-4 h-4 text-destructive" />, list: groups.admins, invite: false },
                    { key: "integrated", label: t("groupIntegrated"), icon: <Link2 className="w-4 h-4 text-accent-hot" />, list: groups.integrated, invite: false },
                    { key: "pending", label: t("groupPending"), icon: <Link2Off className="w-4 h-4 text-soon" />, list: groups.pending, invite: false },
                    { key: "inactive", label: t("groupInactive"), icon: <Moon className="w-4 h-4 text-fg-40" />, list: groups.inactive, invite: false },
                    { key: "invited", label: t("groupInvited"), icon: <Mail className="w-4 h-4 text-accent" />, list: visibleInvites, invite: true },
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
                                                    {sec.list.map(sec.invite ? renderInviteCard : renderUserCard)}
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
