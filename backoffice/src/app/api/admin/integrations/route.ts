import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, isHiperadmin } from "@/lib/admin";
import { accountLabel } from "@/lib/labels";
import { subscriptionUIState } from "@/lib/stripe";
import { isSourceKind, isDestinationKind } from "@/lib/connection-kinds";
import { resolveTier } from "@/lib/billing-legacy";
import {
    deleteConnection, resetConnection, setConnectionStatus,
    deleteLegacyIntegration, resetLegacyIntegration, setLegacyPaused,
} from "@/lib/connection-lifecycle";

export const runtime = "edge";

/**
 * Every integration in the fleet, finished or not.
 *
 * The gap this fills: a merchant who starts an onboarding and walks away leaves
 * a `draft` connection behind. Their own integrations page shows it, but no
 * admin surface did — the client list is one card per account, and an operator
 * could only reach an abandoned setup by impersonating the client. So they were
 * invisible in aggregate and nobody could tidy them up.
 *
 * Two row shapes, deliberately in one list:
 *  - a `connections` row, the modern (source → destination) pipe;
 *  - the legacy Shopify → InvoiceXpress pipe, which lives in `integrations` and
 *    has no `connections` row at all. Leaving it out would hide the oldest and
 *    largest part of the fleet from a page whose whole point is completeness.
 *
 * Never selects `source_config_json` or `destination_config_json`. Those blobs
 * hold live Stripe keys, webhook secrets and Moloni passwords; only the two
 * identifying fields come out, by json_extract, and "are there credentials at
 * all" is answered as a boolean.
 */

const LEGACY_KEY = "shopify:invoicexpress";

interface SubRow {
    user_id: string;
    connection_key: string;
    status: string;
    trial_end: string | null;
    early_bird: number | null;
    stripe_subscription_id: string | null;
    /** The checkout's own contact snapshot. It survives a Clerk-side deletion,
     *  which is the only thing left naming an orphaned connection. */
    name: string | null;
    email: string | null;
    /** Migration 0054. NULL means nobody answered and the price decides. */
    legacy_price: number | null;
}

const rows = (r: any): any[] => (r?.results ?? []) as any[];

export async function GET() {
    try {
        const { userId } = await auth();
        if (!userId || !(await isAdmin(userId))) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { env } = getRequestContext();
        const db = (env as any).DB;
        if (!db) return NextResponse.json({ error: "No database binding" }, { status: 500 });

        // `<> '{}'` matters: an onboarding that got as far as creating the row
        // and no further stores an empty object, not NULL, and calling that
        // "configured" is exactly the lie this page exists to stop telling.
        const CONN_SQL = `
          SELECT c.id, c.user_id, c.source_kind, c.destination_kind, c.status,
                 c.created_at, c.updated_at, c.admin_label, c.invoice_cutoff,
                 (c.source_config_json IS NOT NULL AND c.source_config_json <> '' AND c.source_config_json <> '{}')           AS has_source,
                 (c.destination_config_json IS NOT NULL AND c.destination_config_json <> '' AND c.destination_config_json <> '{}') AS has_destination,
                 json_extract(c.source_config_json, '$.stripe_account_id') AS stripe_account_id,
                 json_extract(c.source_config_json, '$.shop_domain')       AS shop_domain,
                 json_extract(c.destination_config_json, '$.ix_account_name')     AS ix_account_name,
                 json_extract(c.destination_config_json, '$.moloni_company_name') AS moloni_company_name
          FROM connections c
        `;
        // invoice_cutoff arrived in 0023 and admin_label in 0046; a database
        // missing either must still render the page.
        const CONN_SQL_LEGACY = CONN_SQL
            .replace("c.admin_label, c.invoice_cutoff,", "NULL AS admin_label, NULL AS invoice_cutoff,");

        const [userRows, connRows, subRows_, integrationRows, orderRows] = await Promise.all([
            db.prepare(
                `SELECT id, email, name, company_name, admin_label, role,
                        COALESCE(is_inactive, 0) AS is_inactive
                 FROM users`
            ).all().catch(() => ({ results: [] })),
            db.prepare(CONN_SQL).all().catch(() => db.prepare(CONN_SQL_LEGACY).all()),
            db.prepare(
                `SELECT user_id, connection_key, status, trial_end, early_bird,
                        stripe_subscription_id, name, email
                 FROM subscriptions`
            ).all().catch(() => ({ results: [] })),
            db.prepare(
                `SELECT user_id, shopify_domain, ix_account_name,
                        COALESCE(shopify_authorized, 0) AS shopify_authorized,
                        COALESCE(ix_authorized, 0)      AS ix_authorized,
                        COALESCE(is_paused, 0)          AS is_paused,
                        shopify_error, ix_error, created_at, updated_at
                 FROM integrations
                 WHERE shopify_domain IS NOT NULL OR ix_account_name IS NOT NULL`
            ).all().catch(() => ({ results: [] })),
            // How much has actually flowed through each pipe. A draft with
            // documents behind it is a different thing from one with none, and
            // it is the number that says whether deleting is safe.
            db.prepare(
                `SELECT user_id, source_kind, destination_kind, COUNT(*) AS n
                 FROM processed_orders
                 WHERE user_id IS NOT NULL AND invoice_id IS NOT NULL
                 GROUP BY user_id, source_kind, destination_kind`
            ).all().catch(() => ({ results: [] })),
        ]);

        const usersById = new Map<string, any>();
        for (const u of rows(userRows)) usersById.set(u.id, u);

        const subsByUser = new Map<string, SubRow[]>();
        for (const s of rows(subRows_) as SubRow[]) {
            const list = subsByUser.get(s.user_id) ?? [];
            list.push(s);
            subsByUser.set(s.user_id, list);
        }

        const docsByPipe = new Map<string, number>();
        for (const o of rows(orderRows)) {
            docsByPipe.set(`${o.user_id}::${o.source_kind}::${o.destination_kind}`, Number(o.n));
        }

        /**
         * What to call an account whose `users` row is gone.
         *
         * The Clerk webhook's "deep delete" only removed `integrations` and
         * `users`, so a connection could outlive its owner with nothing but a
         * Clerk id naming it — unreadable, and impossible to tell apart from
         * any other. The subscription's checkout snapshot survives that path,
         * so it is the last thing that knows who this was.
         */
        const orphanLabel = (userId_: string): string | null => {
            const s = (subsByUser.get(userId_) ?? []).find((x) => x.name || x.email);
            return s?.name || s?.email || null;
        };

        /** The subscription row that answers for a pipe: its own, or the
         *  account's best if it rides on one. */
        const subFor = (userId_: string, key: string): SubRow | null => {
            const subs = subsByUser.get(userId_) ?? [];
            const own = subs.find((s) => s.connection_key === key);
            if (own) return own;
            const rank = (s: SubRow) => (s.status === "active" ? 3 : s.status === "trialing" ? 2 : 1);
            return [...subs].sort((a, b) => rank(b) - rank(a))[0] ?? null;
        };

        /** Whether this pipe is on the old plan. No Stripe call here — this page
         *  lists the whole fleet, and the column plus the amounts already answer
         *  for everyone the backfill touched. */
        const legacyFor = (userId_: string, key: string) =>
            resolveTier({ override: subFor(userId_, key)?.legacy_price ?? null }).legacy;

        /** The verdict the worker's gate would reach for this pipe. */
        const subStateFor = (userId_: string, key: string, role: string | null) => {
            if (role === "superadmin" || role === "hiperadmin") return "exempt";
            const subs = subsByUser.get(userId_) ?? [];
            const own = subs.find((s) => s.connection_key === key);
            // A second pipe rides the account's subscription — it is free. Show
            // the best row the account holds rather than calling a paying client
            // unsubscribed.
            const rank = (s: SubRow) => (s.status === "active" ? 3 : s.status === "trialing" ? 2 : 1);
            const sub = own ?? [...subs].sort((a, b) => rank(b) - rank(a))[0];
            if (!sub) return "none";
            return subscriptionUIState(sub as any);
        };

        const entries: any[] = [];

        for (const c of rows(connRows)) {
            const u = usersById.get(c.user_id);
            const key = `${c.source_kind}:${c.destination_kind}`;
            const hasSource = !!Number(c.has_source);
            const hasDestination = !!Number(c.has_destination);
            entries.push({
                kind: "connection",
                id: c.id,
                user_id: c.user_id,
                account: u ? accountLabel(u, u.email) : (orphanLabel(c.user_id) ?? c.user_id),
                email: u?.email ?? orphanLabel(c.user_id),
                account_inactive: Number(u?.is_inactive ?? 0) === 1,
                account_role: u?.role ?? "user",
                /** An account row that no longer exists. Real, and worth seeing. */
                orphan: !u,
                source: c.source_kind,
                destination: c.destination_kind,
                connection_key: key,
                status: c.status,
                label: c.admin_label ?? null,
                identifier: c.stripe_account_id ?? c.shop_domain ?? c.ix_account_name ?? c.moloni_company_name ?? null,
                has_source: hasSource,
                has_destination: hasDestination,
                /** What "incomplete" actually means: a side with no credentials
                 *  at all, or a row still sitting in draft. */
                complete: c.status === "active" && hasSource && hasDestination,
                documents: docsByPipe.get(`${c.user_id}::${c.source_kind}::${c.destination_kind}`) ?? 0,
                invoice_cutoff: c.invoice_cutoff ?? null,
                created_at: c.created_at ?? null,
                updated_at: c.updated_at ?? null,
                sub_state: subStateFor(c.user_id, key, u?.role ?? null),
                legacy_price: legacyFor(c.user_id, key),
                can_delete: true,
            });
        }

        for (const i of rows(integrationRows)) {
            const u = usersById.get(i.user_id);
            const shopifyOk = Number(i.shopify_authorized) === 1;
            const ixOk = Number(i.ix_authorized) === 1;
            entries.push({
                kind: "legacy",
                id: `legacy::${i.user_id}`,
                user_id: i.user_id,
                account: u ? accountLabel(u, u.email) : (orphanLabel(i.user_id) ?? i.user_id),
                email: u?.email ?? null,
                account_inactive: Number(u?.is_inactive ?? 0) === 1,
                account_role: u?.role ?? "user",
                orphan: !u,
                source: "shopify",
                destination: "invoicexpress",
                connection_key: LEGACY_KEY,
                status: Number(i.is_paused) === 1 ? "paused" : (shopifyOk && ixOk ? "active" : "draft"),
                label: u?.admin_label ?? null,
                identifier: i.shopify_domain ?? i.ix_account_name ?? null,
                has_source: shopifyOk,
                has_destination: ixOk,
                complete: shopifyOk && ixOk,
                error: i.shopify_error ?? i.ix_error ?? null,
                documents: docsByPipe.get(`${i.user_id}::shopify::invoicexpress`)
                    ?? docsByPipe.get(`${i.user_id}::null::null`) ?? 0,
                created_at: i.created_at ?? null,
                updated_at: i.updated_at ?? null,
                sub_state: subStateFor(i.user_id, LEGACY_KEY, u?.role ?? null),
                legacy_price: legacyFor(i.user_id, LEGACY_KEY),
                // Its verbs mean something different — see connection-lifecycle:
                // reset keeps the fiscal settings, delete takes them with it.
                can_delete: true,
            });
        }

        return NextResponse.json({ integrations: entries });
    } catch (error: any) {
        console.error("[admin/integrations] GET failed:", error?.message ?? error);
        return NextResponse.json({ error: "list_failed" }, { status: 500 });
    }
}

/**
 * Act on one connection, on behalf of an operator rather than of its owner.
 *
 * Same narrow meaning of "delete" the merchant route documents: it removes the
 * CONNECTION — credentials, settings, authorisation — and never the documents
 * already issued or the `processed_orders` rows recording them. Those are the
 * merchant's fiscal history and the reason a re-setup does not re-invoice a
 * year of sales.
 *
 * `confirm` must equal `<source>:<destination>`, exactly as on the merchant
 * route. The typed confirmation in the UI is the human guard; this is the one
 * that stops a stray fetch or a replayed request.
 */
export async function POST(request: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId || !(await isAdmin(userId))) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await request.json() as {
            action?: string;
            kind?: string;
            targetUserId?: string;
            source_kind?: string;
            destination_kind?: string;
            confirm?: string;
            force?: boolean;
        };

        const { action, targetUserId, source_kind: src, destination_kind: dest } = body;
        const legacy = body.kind === "legacy";
        if (!targetUserId) return NextResponse.json({ error: "Missing targetUserId" }, { status: 400 });
        if (!legacy && (!isSourceKind(src) || !isDestinationKind(dest))) {
            return NextResponse.json({ error: "Unknown connection kind" }, { status: 400 });
        }

        const { env } = getRequestContext();
        const db = (env as any).DB;
        if (!db) return NextResponse.json({ error: "No database binding" }, { status: 500 });

        // Keep superadmins out of hiperadmin accounts — the same invisibility
        // rule /api/admin/users applies to the client list. An orphan has no
        // users row to read a role from, and is nobody's account to protect.
        const target: any = await db.prepare("SELECT role FROM users WHERE id = ?").bind(targetUserId).first();
        if (target?.role === "hiperadmin" && !(await isHiperadmin(userId))) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
        }

        const what = legacy ? LEGACY_KEY : `${src}:${dest}`;
        const say = (result: unknown) => {
            console.warn(`[admin/integrations] ${action} ${what} on ${targetUserId} by ${userId}`);
            return NextResponse.json(result as any);
        };

        if (action === "pause" || action === "resume") {
            const paused = action === "pause";
            return say(legacy
                ? await setLegacyPaused(db, targetUserId, paused)
                : await setConnectionStatus(db, targetUserId, src!, dest!, paused ? "paused" : "active"));
        }

        if (action !== "delete" && action !== "reset") {
            return NextResponse.json({ error: "Unknown action" }, { status: 400 });
        }
        if (body.confirm !== what) {
            return NextResponse.json({ error: "Confirmation does not match this connection" }, { status: 400 });
        }

        if (legacy) {
            if (action === "reset") return say(await resetLegacyIntegration(db, targetUserId));

            // Deleting the legacy row takes the account's fiscal settings with
            // it, so a pipe that has issued documents refuses and reports what
            // is attached. The operator confirms against real numbers.
            const result = await deleteLegacyIntegration(db, targetUserId, !!body.force);
            if ("requires_force" in result) return NextResponse.json(result, { status: 409 });
            return say(result);
        }

        return say(action === "delete"
            ? await deleteConnection(db, targetUserId, src!, dest!)
            : await resetConnection(db, targetUserId, src!, dest!));
    } catch (error: any) {
        console.error("[admin/integrations] POST failed:", error?.message ?? error);
        return NextResponse.json({ error: "action_failed" }, { status: 500 });
    }
}
