import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, getRole, getImpersonationId } from "@/lib/admin";
import { subscriptionUIState } from "@/lib/stripe";
import { accountLabel } from "@/lib/labels";

export const runtime = "edge";

/**
 * One card per CONNECTION, not per account.
 *
 * The page used to render one row per `users` row and let SQL fan it out, so a
 * merchant with two pipes (WHM: Shopify->IX and Stripe->IX) appeared twice with
 * every field identical — same platforms on both cards, and one label edit
 * changing both. The account stays the unit of billing and identity (see the
 * account-not-connection-scoped rule), but the unit an operator LOOKS at is the
 * connection, so that is what a card is.
 *
 * Assembled in JS from four flat reads rather than one join: joining
 * subscriptions (PK user_id+connection_key) to integrations multiplies rows,
 * which is exactly the bug this replaces.
 */

interface SubRow {
    user_id: string;
    connection_key: string;
    status: string;
    plan: string | null;
    trial_end: string | null;
    current_period_end: string | null;
    early_bird: number | null;
    stripe_subscription_id: string | null;
}

const LEGACY_KEY = "shopify:invoicexpress";

/** Which subscription answers for this pipe, and did it have one of its own? */
function subFor(subs: SubRow[], key: string | null): { sub: SubRow | null; inherited: boolean } {
    if (subs.length === 0) return { sub: null, inherited: false };
    const own = key ? subs.find(s => s.connection_key === key) : undefined;
    if (own) return { sub: own, inherited: false };
    // A second pipe rides on the account's subscription (it is free — see the
    // account-not-connection-scoped rule). Show the best row the account holds,
    // so a card cannot read "no sub" for a client who is paying.
    const rank = (s: SubRow) => (s.status === "active" ? 3 : s.status === "trialing" ? 2 : 1);
    const best = [...subs].sort((a, b) => rank(b) - rank(a))[0];
    return { sub: best, inherited: true };
}

/** GET /api/admin/users */
export async function GET(request: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId || !(await isAdmin(userId))) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        // When impersonating, the visible role is the IMPERSONATED user's role, not the real admin's.
        // This ensures e.g. a superadmin impersonating another superadmin cannot see hiperadmin accounts.
        const impersonationId = await getImpersonationId(request);
        const viewerUserId = impersonationId || userId;  // who is *viewing* the page
        const viewerRole = await getRole(viewerUserId);

        const { env } = getRequestContext();
        const db = (env as any).DB;

        // The membership join needs migration 0039 and is_inactive needs 0046;
        // before either is applied the same list is served without them.
        const USERS_SQL = `
      SELECT
        u.id, u.email, u.name, u.role, u.last_login, u.created_at,
        u.nif, u.company_name, u.admin_label, u.fiscal_address, u.phone, u.website, u.registration_completed,
        u.acq_utm_source, u.acq_utm_medium, u.acq_referrer, u.acq_landing, u.acq_country, u.acq_captured_at,
        COALESCE(u.is_inactive, 0) AS is_inactive,
        i.shopify_domain, i.shopify_authorized, i.shopify_error,
        i.ix_authorized, i.ix_error,
        m.role as member_role, m.account_id as member_of_id,
        mo_label.label as member_of_label
      FROM users u
      LEFT JOIN integrations i ON u.id = i.user_id
      -- Extra users (migration 0039) are not accounts of their own: show whose
      -- account they belong to instead of a lone row with no subscription.
      LEFT JOIN account_members m ON m.member_user_id = u.id AND m.status = 'active'
      LEFT JOIN (
        SELECT id, COALESCE(NULLIF(company_name, ''), NULLIF(admin_label, ''), NULLIF(name, ''), email, id) AS label
        FROM users
      ) mo_label ON mo_label.id = m.account_id
      ORDER BY u.created_at DESC
`;
        const USERS_SQL_LEGACY = `
      SELECT
        u.id, u.email, u.name, u.role, u.last_login, u.created_at,
        u.nif, u.company_name, u.admin_label, u.fiscal_address, u.phone, u.website, u.registration_completed,
        u.acq_utm_source, u.acq_utm_medium, u.acq_referrer, u.acq_landing, u.acq_country, u.acq_captured_at,
        0 AS is_inactive,
        i.shopify_domain, i.shopify_authorized, i.shopify_error,
        i.ix_authorized, i.ix_error
      FROM users u
      LEFT JOIN integrations i ON u.id = i.user_id
      ORDER BY u.created_at DESC
`;
        const userRows = await db.prepare(USERS_SQL).all()
            .catch(() => db.prepare(USERS_SQL_LEGACY).all());

        // Only the two identifying fields are read out of the config blobs. The
        // rest holds live API keys (never-print-secrets): never SELECT the blob
        // itself into a payload the browser receives.
        const CONN_SQL = `
      SELECT id, user_id, source_kind, destination_kind, status, created_at, admin_label,
             json_extract(source_config_json, '$.stripe_account_id') AS stripe_account_id,
             json_extract(source_config_json, '$.shop_domain')        AS shop_domain
      FROM connections
`;
        const CONN_SQL_LEGACY = CONN_SQL.replace(", admin_label", ", NULL AS admin_label");
        const connRows = await db.prepare(CONN_SQL).all()
            .catch(() => db.prepare(CONN_SQL_LEGACY).all());

        const subRows = await db.prepare(
            `SELECT user_id, connection_key, status, plan, trial_end, current_period_end,
                    early_bird, stripe_subscription_id
             FROM subscriptions`
        ).all();

        // Invited extra users get their own group on the page: an invite is
        // neither an account nor an integration, and reads as a broken shop in
        // either of those groups.
        const inviteRows = await db.prepare(
            `SELECT am.id, am.account_id, am.email, am.member_user_id, am.role, am.status,
                    am.seat_paid_at, am.seat_amount_cents, am.seat_reused_from,
                    am.created_at, am.accepted_at, am.revoked_at, am.invited_by,
                    mu.name AS member_name, mu.last_login AS member_last_login,
                    ib.name AS invited_by_name, ib.email AS invited_by_email
             FROM account_members am
             LEFT JOIN users mu ON mu.id = am.member_user_id
             LEFT JOIN users ib ON ib.id = am.invited_by
             ORDER BY am.created_at DESC`
        ).all().catch(() => ({ results: [] as any[] }));

        const users = (userRows.results ?? []) as any[];
        const conns = (connRows.results ?? []) as any[];
        const subs = (subRows.results ?? []) as SubRow[];

        const connsByUser = new Map<string, any[]>();
        for (const c of conns) {
            const list = connsByUser.get(c.user_id) ?? [];
            list.push(c);
            connsByUser.set(c.user_id, list);
        }
        const subsByUser = new Map<string, SubRow[]>();
        for (const s of subs) {
            const list = subsByUser.get(s.user_id) ?? [];
            list.push(s);
            subsByUser.set(s.user_id, list);
        }

        const entries: any[] = [];
        for (const u of users) {
            const isAdminRole = u.role === "superadmin" || u.role === "hiperadmin";
            const userSubs = subsByUser.get(u.id) ?? [];
            const userConns = connsByUser.get(u.id) ?? [];

            /** Everything a card needs that belongs to the ACCOUNT, not the pipe. */
            const base = {
                ...u,
                is_inactive: Number(u.is_inactive) === 1,
                account_label: accountLabel(u, u.email),
            };

            const withSub = (entry: any, key: string | null) => {
                const { sub, inherited } = subFor(userSubs, key);
                const sub_state = isAdminRole
                    ? "exempt"
                    // The badge a superadmin reads must be the SAME verdict the
                    // worker gate applies, or this page will call a shop active
                    // while its invoices are being refused. Admins are exempt by
                    // role, exactly as checkSubscriptionGate exempts them.
                    : subscriptionUIState({
                        status: sub?.status,
                        trial_end: sub?.trial_end,
                        early_bird: sub?.early_bird,
                        stripe_subscription_id: sub?.stripe_subscription_id,
                    } as any);
                return {
                    ...entry,
                    sub_status: sub?.status ?? null,
                    sub_plan: sub?.plan ?? null,
                    sub_trial_end: sub?.trial_end ?? null,
                    sub_period_end: sub?.current_period_end ?? null,
                    sub_early_bird: sub?.early_bird ?? null,
                    sub_stripe_id: sub?.stripe_subscription_id ?? null,
                    sub_inherited: inherited,
                    sub_state,
                };
            };

            // 1. The legacy Shopify->IX pipe, which lives in `integrations` and
            //    has no row in `connections` at all.
            const hasLegacy = !!(u.shopify_domain || u.shopify_authorized || u.ix_authorized);
            if (hasLegacy) {
                entries.push(withSub({
                    ...base,
                    entry_id: `${u.id}::${LEGACY_KEY}`,
                    connection_key: LEGACY_KEY,
                    connection_id: null,
                    source: "shopify",
                    destination: "invoicexpress",
                    conn_status: null,
                    legacy: true,
                    // The Shopify pipe is named by the account label: it predates
                    // per-connection labels and every other page still reads it.
                    entry_label: u.admin_label || null,
                    label_scope: "account",
                    identifier: u.shopify_domain ?? null,
                    identifier_kind: u.shopify_domain ? "domain" : null,
                    source_ok: !!u.shopify_authorized,
                    source_err: u.shopify_error ?? null,
                    source_off: !u.shopify_domain,
                    dest_ok: !!u.ix_authorized,
                    dest_err: u.ix_error ?? null,
                    dest_off: false,
                    integrated: !!(u.shopify_authorized && u.ix_authorized),
                }, LEGACY_KEY));
            }

            // 2. Every modern connection.
            for (const c of userConns) {
                const key = `${c.source_kind}:${c.destination_kind}`;
                const live = c.status === "active";
                entries.push(withSub({
                    ...base,
                    entry_id: `${u.id}::conn::${c.id}`,
                    connection_key: key,
                    connection_id: c.id,
                    source: c.source_kind,
                    destination: c.destination_kind,
                    conn_status: c.status,
                    legacy: false,
                    entry_label: c.admin_label || null,
                    label_scope: "connection",
                    connection_created_at: c.created_at ?? null,
                    identifier: c.stripe_account_id ?? c.shop_domain ?? null,
                    identifier_kind: c.stripe_account_id ? "stripe_account" : (c.shop_domain ? "domain" : null),
                    source_ok: live,
                    source_err: null,
                    source_off: !live,
                    dest_ok: live,
                    dest_err: null,
                    dest_off: !live,
                    integrated: live,
                }, key));
            }

            // 3. No pipe at all — still one card, so the account stays visible.
            if (!hasLegacy && userConns.length === 0) {
                entries.push(withSub({
                    ...base,
                    entry_id: `${u.id}::none`,
                    connection_key: null,
                    connection_id: null,
                    source: null,
                    destination: null,
                    conn_status: null,
                    legacy: false,
                    entry_label: u.admin_label || null,
                    label_scope: "account",
                    identifier: null,
                    identifier_kind: null,
                    source_ok: false,
                    source_err: null,
                    source_off: true,
                    dest_ok: false,
                    dest_err: null,
                    dest_off: true,
                    integrated: false,
                }, null));
            }
        }

        // Filter visible entries based on the VIEWER's role (impersonation-aware)
        let visible = entries;
        let invites = ((inviteRows as any).results ?? []) as any[];
        if (viewerRole === "superadmin") {
            // Superadmin CANNOT see hiperadmin — hiperadmin is invisible to everyone except itself
            visible = visible.filter((e: any) => e.role !== "hiperadmin");
        }
        // hiperadmin (viewing as themselves) sees everyone

        const visibleIds = new Set(visible.map((e: any) => e.id));
        invites = invites.filter((i: any) => visibleIds.has(i.account_id));

        // Return viewer metadata so the frontend can determine its own capabilities without relying on Clerk
        return NextResponse.json({
            users: visible,
            invites,
            accounts: visibleIds.size,
            _viewer_role: viewerRole,
            _viewer_id: viewerUserId,
        });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

/** PATCH /api/admin/users — role, labels, and the inactive flag */
export async function PATCH(request: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId || !(await isAdmin(userId))) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const callerRole = await getRole(userId);
        const body = await request.json() as {
            targetId: string; role?: string; admin_label?: string;
            connectionId?: string | null; is_inactive?: boolean;
        };
        const { targetId, role } = body;
        if (!targetId) return NextResponse.json({ error: "Missing targetId" }, { status: 400 });

        const { env } = getRequestContext();
        const db = (env as any).DB;

        // Label edit — identification only, never touches fiscal company_name.
        // Scoped to the connection when one is named, so two pipes on the same
        // account can be told apart instead of overwriting each other.
        if (body.admin_label !== undefined) {
            const label = body.admin_label.trim().slice(0, 80) || null;
            if (body.connectionId) {
                await db.prepare("UPDATE connections SET admin_label = ? WHERE id = ? AND user_id = ?")
                    .bind(label, body.connectionId, targetId).run();
            } else {
                await db.prepare("UPDATE users SET admin_label = ? WHERE id = ?").bind(label, targetId).run();
            }
            return NextResponse.json({ success: true });
        }

        // Dormant account: no warning emails, newsletters only. A deliberate
        // state, not a fault — see migration 0046.
        if (body.is_inactive !== undefined) {
            await db.prepare("UPDATE users SET is_inactive = ? WHERE id = ?")
                .bind(body.is_inactive ? 1 : 0, targetId).run();
            return NextResponse.json({ success: true, is_inactive: body.is_inactive ? 1 : 0 });
        }

        // Valid target roles depending on caller
        const hiperadminRoles = ["superadmin", "user"];
        const superadminRoles = ["user"];
        const allowedRoles = callerRole === "hiperadmin" ? hiperadminRoles : superadminRoles;

        if (!role || !allowedRoles.includes(role)) {
            return NextResponse.json({ error: `Role '${role}' not allowed for your level` }, { status: 400 });
        }

        const target: any = await db.prepare("SELECT role FROM users WHERE id = ?").bind(targetId).first();

        // Only hiperadmin can act on hiperadmin or superadmin accounts
        if (target?.role === "hiperadmin") {
            return NextResponse.json({ error: "Cannot change hiperadmin role" }, { status: 403 });
        }
        if (target?.role === "superadmin" && callerRole !== "hiperadmin") {
            return NextResponse.json({ error: "Only hiperadmin can change superadmin role" }, { status: 403 });
        }

        await db.prepare("UPDATE users SET role = ? WHERE id = ?").bind(role, targetId).run();
        return NextResponse.json({ success: true });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

/**
 * DELETE /api/admin/users — deletes the whole ACCOUNT, never one connection.
 *
 * The button that calls this sits on a card, and a card is now a connection, so
 * it reads as "remove this pipe". It is not: MeetFrank was deleted whole —
 * account row gone, 725 invoiced orders and a live Stripe→IX connection left
 * pointing at a user that no longer existed, still invoicing, invisible to the
 * page (09/09/2026). Nothing had asked whether that was the intention.
 *
 * So an account that has anything attached is refused unless the caller says
 * `force`, and the refusal reports exactly what is attached — the operator
 * confirms against the real numbers, not against a trash icon. When it does go
 * ahead it takes the connections and subscriptions with it, because a live
 * connection outliving its account keeps invoicing for nobody.
 *
 * `processed_orders` and the documents stay: they are the fiscal record of
 * invoices actually issued, and they are what made the recovery above possible.
 */
export async function DELETE(request: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId || !(await isAdmin(userId))) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const callerRole = await getRole(userId);
        const { targetId, force } = await request.json() as { targetId: string; force?: boolean };
        if (!targetId) return NextResponse.json({ error: "Missing targetId" }, { status: 400 });

        const { env } = getRequestContext();
        const db = (env as any).DB;
        const target: any = await db.prepare("SELECT role FROM users WHERE id = ?").bind(targetId).first();

        if (target?.role === "hiperadmin") return NextResponse.json({ error: "Cannot delete hiperadmin" }, { status: 403 });
        if (target?.role === "superadmin" && callerRole !== "hiperadmin") return NextResponse.json({ error: "Only hiperadmin can delete superadmins" }, { status: 403 });

        // What would be destroyed, and what would be orphaned.
        const counts: any = await db.prepare(
            `SELECT
               (SELECT COUNT(*) FROM connections      WHERE user_id = ?1) AS connections,
               (SELECT COUNT(*) FROM integrations     WHERE user_id = ?1) AS integrations,
               (SELECT COUNT(*) FROM processed_orders WHERE user_id = ?1) AS orders`
        ).bind(targetId).first().catch(() => ({ connections: 0, integrations: 0, orders: 0 }));

        const connections = Number(counts?.connections ?? 0);
        const integrations = Number(counts?.integrations ?? 0);
        const orders = Number(counts?.orders ?? 0);

        if (!force && (connections > 0 || integrations > 0 || orders > 0)) {
            return NextResponse.json({
                error: "This deletes the whole account, not one connection",
                requires_force: true,
                connections, integrations, orders,
            }, { status: 409 });
        }

        // The shop domain has to be read BEFORE the integrations row goes, or the
        // log cleanup runs against a subquery that already returns NULL.
        const shop: any = await db.prepare("SELECT shopify_domain FROM integrations WHERE user_id = ?").bind(targetId).first().catch(() => null);

        await db.prepare("DELETE FROM integrations WHERE user_id = ?").bind(targetId).run();
        if (shop?.shopify_domain) {
            await db.prepare("DELETE FROM logs WHERE shopify_domain = ?").bind(shop.shopify_domain).run().catch(() => { });
        }
        await db.prepare("DELETE FROM connections WHERE user_id = ?").bind(targetId).run().catch(() => { });
        await db.prepare("DELETE FROM subscriptions WHERE user_id = ?").bind(targetId).run().catch(() => { });
        await db.prepare("DELETE FROM account_members WHERE account_id = ?").bind(targetId).run().catch(() => { });
        await db.prepare("DELETE FROM users WHERE id = ?").bind(targetId).run();

        console.warn(`[admin/users] account ${targetId} deleted by ${userId} — ${connections} connection(s), ${integrations} integration(s), ${orders} invoiced order(s) left on record`);
        return NextResponse.json({ success: true, deleted: { connections, integrations, orders } });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
