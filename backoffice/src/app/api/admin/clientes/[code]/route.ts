import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";

import { isAdmin, isHiperadmin, getRole, getImpersonationId } from "@/lib/admin";
import { resolveClientCode, lookupRetiredCode, ensureClientCode } from "@/lib/client-code";
import { accountLabel } from "@/lib/labels";
import { loadBillingIdentity } from "@/lib/billing-identity";
import { CONNECTION_PUBLIC_SELECT, redactConfigJson, stripIntegrationSecrets } from "@/lib/redact";
import { listSubscriptions, stripeDashboardBase, subscriptionUIState } from "@/lib/stripe";
import { resolveTier, sunsetAt } from "@/lib/billing-legacy";
import { priceBook } from "@/lib/price-book";
import { getSeatPool } from "@/lib/account";

export const runtime = "edge";

/**
 * Everything about one customer, in one answer.
 *
 * One route rather than six, because six means six `auth()` calls, six `getRole`
 * reads and six places the next migration can leak a column. The redaction
 * happens here, once, on its way out — `lib/redact` is the allowlist and nothing
 * bypasses it.
 *
 * What is NOT here, on purpose, and is fetched when its tab is opened:
 *   · the Kapta service invoices — `/api/admin/dev-mode/link-ix` calls the
 *     InvoiceXpress API, and an external call has no business in a first paint
 *   · config_audit, incidents, document events — three routes that already exist
 *     and already take `user_id`
 *
 * The reads below are flat and crossed in JS. A join between `subscriptions`
 * (PK user_id + connection_key) and `integrations` multiplies rows, which is the
 * bug /api/admin/users documents having had.
 */

/** Columns of `users` a record may show. Never `SELECT *`. */
const USER_COLUMNS = `
    u.id, u.client_code, u.email, u.name, u.role, u.created_at, u.last_login,
    u.nif, u.company_name, u.admin_label, u.fiscal_address, u.phone, u.website,
    u.registration_completed, u.privacy_policy_accepted, u.privacy_policy_accepted_at,
    u.onboarding_source_kind, u.onboarding_destination_kind,
    u.acq_utm_source, u.acq_utm_medium, u.acq_referrer, u.acq_landing, u.acq_country, u.acq_captured_at,
    COALESCE(u.is_inactive, 0) AS is_inactive`;

/** The same list for a database where 0058 has not been applied yet. */
const USER_COLUMNS_PRE_0058 = USER_COLUMNS.replace("u.client_code, ", "NULL AS client_code, ");

const LEGACY_CONNECTION_KEY = "shopify:invoicexpress";

export async function GET(request: NextRequest, ctx: { params: Promise<{ code: string }> }) {
    try {
        const { userId } = await auth();
        if (!userId || !(await isAdmin(userId))) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { env } = getRequestContext();
        const db = (env as any).DB;
        if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

        const { code } = await ctx.params;
        const resolved = await resolveClientCode(db, code);
        if (!resolved) {
            // A number that was issued and whose account is gone is a different
            // answer from a typo, and the operator holding it deserves to know
            // which they have.
            const retired = await lookupRetiredCode(db, code);
            return NextResponse.json({ error: "not_found", retired }, { status: 404 });
        }

        const accountId = resolved.accountId;

        // The role rules of /api/admin/users apply here too: a superadmin cannot
        // open a hiperadmin's record, impersonation included.
        const viewerRole = await getRole((await getImpersonationId(request)) || userId);
        const targetRole = await getRole(accountId);
        if (targetRole === "hiperadmin" && viewerRole !== "hiperadmin") {
            return NextResponse.json({ error: "not_found", retired: null }, { status: 404 });
        }

        // The fiscal configuration is hiperadmin-only wherever it is served
        // (/api/admin/client-rules gates both verbs on it, and gating the page
        // and not the data gates nothing). Omitted from the payload rather than
        // hidden in the UI.
        const fiscalVisible = await isHiperadmin(userId);

        const userRow: any = await db.prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = ?`)
            .bind(accountId).first()
            .catch(() => db.prepare(`SELECT ${USER_COLUMNS_PRE_0058} FROM users u WHERE u.id = ?`)
                .bind(accountId).first());
        if (!userRow) return NextResponse.json({ error: "not_found", retired: null }, { status: 404 });

        const [connRows, legacyRow, subscriptions, identity, events, memberRows, seats, counts] = await Promise.all([
            db.prepare(`
                SELECT ${CONNECTION_PUBLIC_SELECT},
                       destination_config_json,
                       json_extract(source_config_json, '$.stripe_account_id') AS stripe_account_id,
                       json_extract(source_config_json, '$.shop_domain')        AS shop_domain
                  FROM connections WHERE user_id = ? ORDER BY created_at ASC
            `).bind(accountId).all().catch(() => ({ results: [] })),

            db.prepare("SELECT * FROM integrations WHERE user_id = ?").bind(accountId).first().catch(() => null),

            listSubscriptions(db, accountId).catch(() => []),

            loadBillingIdentity(db, accountId).catch(() => null),

            // The payment ledger. `raw_json` holds the whole Stripe object and
            // never leaves the server; only the invoice number is read out of it.
            db.prepare(`
                SELECT id, type, stripe_object_id, payment_intent_id, amount_cents, currency, status,
                       ix_invoice_id, ix_invoice_permalink, ix_match_method, ix_match_score, created_at,
                       json_extract(raw_json, '$.number') AS stripe_invoice_number
                  FROM billing_events
                 WHERE user_id = ?
                 ORDER BY created_at DESC
                 LIMIT 50
            `).bind(accountId).all().catch(() => ({ results: [] })),

            db.prepare(`
                SELECT am.id, am.email, am.member_user_id, am.role, am.status,
                       am.created_at, am.accepted_at, am.revoked_at
                  FROM account_members am
                 WHERE am.account_id = ? ORDER BY am.created_at DESC
            `).bind(accountId).all().catch(() => ({ results: [] })),

            getSeatPool(accountId).catch(() => null),

            db.prepare(`
                SELECT (SELECT COUNT(*) FROM processed_orders WHERE user_id = ?1) AS documents,
                       (SELECT COUNT(*) FROM incidents WHERE user_id = ?1 AND status IN ('open','acknowledged')) AS incidents_open
            `).bind(accountId).first().catch(() => ({ documents: 0, incidents_open: 0 })),
        ]);

        // What each subscription costs, so the record can name the plan and the
        // day an old price ends. A Stripe outage costs the badge, not the page.
        const prices = await priceBook().catch(() => new Map());

        const legacy = legacyRow ? stripIntegrationSecrets(legacyRow) : null;
        const hasLegacyPipe = !!(legacyRow?.shopify_domain || legacyRow?.shopify_authorized || legacyRow?.ix_authorized);

        const connections: any[] = [];
        if (hasLegacyPipe) {
            connections.push({
                key: LEGACY_CONNECTION_KEY,
                id: null,
                source_kind: "shopify",
                destination_kind: "invoicexpress",
                status: legacyRow.is_paused ? "paused" : "active",
                legacy: true,
                admin_label: userRow.admin_label ?? null,
                invoice_cutoff: legacyRow.invoice_cutoff ?? null,
                created_at: legacyRow.created_at ?? null,
                identifier: legacyRow.shopify_domain ?? null,
                identifier_kind: legacyRow.shopify_domain ? "domain" : null,
                // The legacy row's fiscal settings are columns, not a blob, and
                // `legacy` already carries them with the credentials stripped.
                fiscal: null,
                credentials_present: null,
            });
        }
        for (const row of ((connRows as any).results ?? []) as any[]) {
            const { fiscal, present } = redactConfigJson(row.destination_config_json);
            connections.push({
                key: `${row.source_kind}:${row.destination_kind}`,
                id: row.id,
                source_kind: row.source_kind,
                destination_kind: row.destination_kind,
                status: row.status,
                legacy: false,
                admin_label: row.admin_label ?? null,
                invoice_cutoff: row.invoice_cutoff ?? null,
                created_at: row.created_at ?? null,
                identifier: row.stripe_account_id ?? row.shop_domain ?? null,
                identifier_kind: row.stripe_account_id ? "stripe_account" : (row.shop_domain ? "domain" : null),
                fiscal: fiscalVisible ? fiscal : null,
                credentials_present: present,
            });
        }

        const subs = (subscriptions as any[]).map((s) => {
            const price = s.price_id ? prices.get(s.price_id) : null;
            const tier = resolveTier({ override: s.legacy_price ?? null, price }).tier;
            const interval = price?.recurring?.interval
                ?? (s.plan === "annual" ? "year" : s.plan === "monthly" ? "month" : null);
            return {
                ...s,
                // The same verdict the worker's gate applies, or this page says
                // "active" while the invoices are being refused.
                sub_state: targetRole === "superadmin" || targetRole === "hiperadmin"
                    ? "exempt"
                    : subscriptionUIState(s as any),
                tier,
                interval,
                unit_amount_cents: price?.unit_amount ?? null,
                sunset_at: sunsetAt({ tier, interval, currentPeriodEnd: s.current_period_end }),
                // Which connection it pays for, and whether that pipe exists.
                connection_exists: connections.some((c) => c.key === s.connection_key),
            };
        });

        const clientCode = userRow.client_code ?? await ensureClientCode(db, accountId);

        return NextResponse.json({
            customer: {
                ...userRow,
                client_code: clientCode,
                is_inactive: Number(userRow.is_inactive) === 1,
                label: accountLabel(userRow, userRow.email),
                identity,
            },
            // Set when the code that was asked for belongs to an invited member:
            // the page says so rather than silently showing someone else.
            asked_for_member: resolved.memberOf,
            connections,
            legacy,
            subscriptions: subs,
            stripe: {
                dashboard_base: stripeDashboardBase(),
                customer_ids: [...new Set(subs.map((s: any) => s.stripe_customer_id).filter(Boolean))],
                events: ((events as any).results ?? []),
            },
            members: ((memberRows as any).results ?? []),
            seats,
            counts,
            fiscal_visible: fiscalVisible,
            viewer_role: viewerRole,
        });
    } catch (error: any) {
        console.error("[admin/clientes] GET failed:", error?.message ?? error);
        return NextResponse.json({ error: "read_failed" }, { status: 500 });
    }
}
