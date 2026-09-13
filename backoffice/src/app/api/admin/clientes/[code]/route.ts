import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";

import { isAdmin, isHiperadmin, getRole, mayViewAccount } from "@/lib/admin";
import { resolveClientCode, lookupRetiredCode, ensureClientCode } from "@/lib/client-code";
import { accountLabel } from "@/lib/labels";
import { auditConfigChange } from "@/lib/config-audit";
import { identityRequestStates } from "@/lib/client-record-sql";
import { loadBillingIdentity } from "@/lib/billing-identity";
import { CONNECTION_PUBLIC_SELECT, redactConfigJson, stripIntegrationSecrets } from "@/lib/redact";
import { listSubscriptions, stripeDashboardBase, subscriptionUIState } from "@/lib/stripe";
import { resolveTier, sunsetAt } from "@/lib/billing-legacy";
import { priceBook } from "@/lib/price-book";
import { getSeatPool } from "@/lib/account";
import { loadAccountReferrals } from "@/lib/client-record-referrals";

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

        // A hiperadmin's record is invisible below hiperadmin, decided on the REAL
        // role of whoever is signed in. It used to read the impersonated role,
        // and /api/admin/impersonate does not check whom it impersonates — so a
        // superadmin impersonating a hiperadmin passed as one. See mayViewAccount.
        if (!(await mayViewAccount(userId, accountId))) {
            return NextResponse.json({ error: "not_found", retired: null }, { status: 404 });
        }
        const viewerRole = await getRole(userId);
        const targetRole = await getRole(accountId);

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

        const [connRows, legacyRow, subscriptions, identity, events, memberRows, seats, counts, requestRows, referrals] = await Promise.all([
            db.prepare(`
                SELECT ${CONNECTION_PUBLIC_SELECT},
                       destination_config_json,
                       source_config_json,
                       json_extract(source_config_json, '$.stripe_account_id') AS stripe_account_id,
                       json_extract(source_config_json, '$.shop_domain')        AS shop_domain
                  FROM connections WHERE user_id = ? ORDER BY created_at ASC
            `).bind(accountId).all().catch(() => ({ results: [] })),

            db.prepare("SELECT * FROM integrations WHERE user_id = ?").bind(accountId).first().catch(() => null),

            listSubscriptions(db, accountId).catch(() => []),

            loadBillingIdentity(db, accountId).catch(() => null),

            // The payment ledger. `raw_json` holds the whole Stripe object and
            // never leaves the server; only the invoice number is read out of it.
            // Payments only: the table also records checkout sessions and
            // subscription updates, which carry no amount and no invoice, and were
            // eating the 50-row window of an account with years of them.
            db.prepare(`
                SELECT id, type, stripe_object_id, payment_intent_id, amount_cents, currency, status,
                       ix_invoice_id, ix_invoice_permalink, ix_match_method, ix_match_score, created_at,
                       json_extract(raw_json, '$.number') AS stripe_invoice_number
                  FROM billing_events
                 WHERE user_id = ?
                   AND type IN ('invoice.paid', 'invoice.payment_failed', 'charge.refunded')
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

            // The whole story of the fiscal identity: what the client asked, what
            // was granted, what was refused. There is no status column on
            // purpose — the state is read off the trail, so nothing has to be
            // closed by hand. See identityRequestStates.
            db.prepare(`
                SELECT id, scope, field, old_value, new_value, actor, created_at
                  FROM config_audit
                 WHERE user_id = ?
                   AND scope IN ('profile_change_request', 'profile', 'profile_change_rejected')
                 ORDER BY created_at DESC, rowid DESC LIMIT 40
            `).bind(accountId).all().catch(() => ({ results: [] })),

            // Who invited this account and whom it invited. Null, not empty, when
            // the read fails: "nobody" would be the page inventing an answer.
            loadAccountReferrals(db, accountId).catch(() => null),
        ]);

        // What each subscription costs, so the record can name the plan and the
        // day an old price ends. A Stripe outage costs the badge, not the page.
        const prices = await priceBook().catch(() => new Map());

        // The legacy row, with credentials reduced to presence flags. Its OTHER
        // columns — force_tax_rate, oss_enabled, the exemption reasons, the
        // series — are the fiscal configuration of the whole Shopify fleet, and
        // are gated to hiperadmin exactly like the connection blobs below.
        // Everyone else gets what the Integrações tab shows. It used to go out
        // whole, to any admin, under a route that says it withholds it.
        const LEGACY_IDENTITY_FIELDS = [
            "shopify_domain", "ix_account_name", "ix_environment", "webhooks_active",
            "shopify_authorized", "ix_authorized", "has_ix_api_key", "has_shopify_token", "is_paused",
        ];
        const legacyStripped = legacyRow ? stripIntegrationSecrets(legacyRow) : null;
        const legacyOut = legacyStripped && !fiscalVisible
            ? Object.fromEntries(LEGACY_IDENTITY_FIELDS.map((k) => [k, legacyStripped[k] ?? null]))
            : legacyStripped;

        // A Shopify card needs a Shopify shop. A row with `ix_authorized` and no
        // shop only ever held InvoiceXpress credentials — the store every
        // connection-based integration files with — and drawing it as a live
        // "Shopify → InvoiceXpress" pipe is the phantom that twice got a real
        // connection's credentials deleted.
        const hasLegacyPipe = !!legacyRow?.shopify_domain;

        // The worker's gate with SUBSCRIPTION_PER_CONNECTION=1: a connection with
        // no subscription row of its own is refused every document. Admin
        // accounts are exempt, exactly as checkSubscriptionGate exempts them.
        const exempt = targetRole === "superadmin" || targetRole === "hiperadmin";
        const subscribedKeys = new Set((subscriptions as any[]).map((s) => s.connection_key));
        const isSubscribed = (key: string) => exempt || subscribedKeys.has(key);

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
                // The legacy row's fiscal settings are columns, not a blob; for a
                // hiperadmin `legacy` carries them with the credentials stripped.
                fiscal: null,
                credentials_present: null,
                subscribed: isSubscribed(LEGACY_CONNECTION_KEY),
            });
        }
        for (const row of ((connRows as any).results ?? []) as any[]) {
            const { fiscal, present } = redactConfigJson(row.destination_config_json);
            // Credentials live in BOTH blobs — a Stripe source keeps its restricted
            // key and webhook secret in source_config_json — while the destination
            // redaction floors every credential it does not hold to false, which
            // printed "✗ restricted_key" beside a working Stripe connection. A key
            // on the checklist is present if either blob has it. Only booleans leave.
            const { present: sourcePresent } = redactConfigJson(row.source_config_json);
            for (const k of Object.keys(present)) if (sourcePresent[k]) present[k] = true;

            const key = `${row.source_kind}:${row.destination_kind}`;
            connections.push({
                key,
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
                subscribed: isSubscribed(key),
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
                sub_state: exempt ? "exempt" : subscriptionUIState(s as any),
                tier,
                interval,
                unit_amount_cents: price?.unit_amount ?? null,
                sunset_at: sunsetAt({ tier, interval, currentPeriodEnd: s.current_period_end }),
                // Which connection it pays for, and whether that pipe exists.
                connection_exists: connections.some((c) => c.key === s.connection_key),
            };
        });

        // Every invitee is a new account, and a new account's number is minted
        // lazily: one who subscribed from an integration page, or never got past
        // the claim, has none yet, and its row had no link to its record. The same
        // safety net as this account's own code, just below.
        if (referrals) {
            await Promise.all(referrals.invited
                .filter((r) => !r.invitee_client_code)
                .map(async (r) => { r.invitee_client_code = await ensureClientCode(db, r.invitee_user_id); }));
        }

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
            legacy: legacyOut,
            subscriptions: subs,
            stripe: {
                dashboard_base: stripeDashboardBase(),
                customer_ids: [...new Set(subs.map((s: any) => s.stripe_customer_id).filter(Boolean))],
                events: ((events as any).results ?? []),
            },
            members: ((memberRows as any).results ?? []),
            seats,
            counts,
            // One row per field the client has ever asked about, with what became
            // of it. The page shows the pending ones as work and the decided ones
            // as history.
            identity_requests: identityRequestStates(((requestRows as any).results ?? []) as any[], userRow),
            referrals,
            fiscal_visible: fiscalVisible,
            viewer_role: viewerRole,
        });
    } catch (error: any) {
        console.error("[admin/clientes] GET failed:", error?.message ?? error);
        return NextResponse.json({ error: "read_failed" }, { status: 500 });
    }
}

/** The two fields a merchant cannot change about themselves. */
const OPERATOR_EDITABLE = new Set(["nif", "company_name"]);

/**
 * Apply a fiscal identity change, from the page where the request is read.
 *
 * The merchant's own route refuses these two once the account is registered, on
 * purpose: they are what already-issued Kapta invoices print and what the
 * payment matcher pairs on. Somebody still has to be able to correct a wrong
 * one, and until this existed that somebody had to impersonate the client and
 * re-run their onboarding form — a detour with no record of who changed what.
 *
 * Hiperadmin, like every other write that decides what a document says, and
 * audited into the same trail the request arrived on, so the two read as one
 * story: asked on the 13th, applied on the 14th, by whom.
 */
export async function PATCH(request: NextRequest, ctx: { params: Promise<{ code: string }> }) {
    try {
        const { userId } = await auth();
        if (!userId || !(await isHiperadmin(userId))) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await request.json() as { field?: string; value?: string; reject?: boolean; reason?: string };
        const field = String(body.field ?? "");
        if (!OPERATOR_EDITABLE.has(field)) {
            return NextResponse.json({ error: "field_not_editable" }, { status: 400 });
        }

        const { env: rejectEnv } = getRequestContext();
        const rejectDb = (rejectEnv as any).DB;

        // ── Refusing ───────────────────────────────────────────────────────────
        //
        // A refusal changes no value, so there is nothing for the derivation to
        // notice — which is why it has to be written down. It goes in the same
        // append-only trail as the request and the grant, so the three read as
        // one story, and the reason is only ever what the operator typed: a
        // refusal with none says so rather than inventing one.
        if (body.reject === true) {
            if (!rejectDb) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });
            const { code: rejectCode } = await ctx.params;
            const target = await resolveClientCode(rejectDb, rejectCode);
            if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });

            const reason = String(body.reason ?? "").trim().slice(0, 300) || null;
            // The row IS the refusal: without it the request still reads as
            // pending and the client is never told. Saying "recusado" over a
            // failed write would be the page lying to the operator.
            const recorded = await auditConfigChange(rejectDb, {
                userId: target.accountId,
                actor: userId,
                scope: "profile_change_rejected",
                field,
                oldValue: null,
                newValue: reason,
            });
            if (!recorded) return NextResponse.json({ error: "write_failed" }, { status: 500 });
            return NextResponse.json({ success: true, rejected: true });
        }

        // An empty string is "unset", not the empty string — same rule the fiscal
        // console applies to every text field it writes.
        const raw = String(body.value ?? "").trim();
        const value = raw === "" ? null : raw.slice(0, 120);
        if (field === "nif" && value !== null && !/^\d{9}$/.test(value)) {
            return NextResponse.json({ error: "nif_must_be_nine_digits" }, { status: 400 });
        }

        const { env } = getRequestContext();
        const db = (env as any).DB;
        if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

        const { code } = await ctx.params;
        const resolved = await resolveClientCode(db, code);
        if (!resolved) return NextResponse.json({ error: "not_found" }, { status: 404 });

        const before: any = await db.prepare(`SELECT ${field} AS value FROM users WHERE id = ?`)
            .bind(resolved.accountId).first();
        if (!before) return NextResponse.json({ error: "not_found" }, { status: 404 });
        if (String(before.value ?? "") === String(value ?? "")) {
            return NextResponse.json({ success: true, unchanged: true, value });
        }

        await db.prepare(`UPDATE users SET ${field} = ? WHERE id = ?`).bind(value, resolved.accountId).run();

        // The value is already written, so a failed audit is not a failed grant.
        // It is still said: without the row the request is only derived as
        // granted, and the client's notice has no decision date.
        const audited = await auditConfigChange(db, {
            userId: resolved.accountId,
            actor: userId,
            scope: "profile",
            field,
            oldValue: before.value,
            newValue: value,
        });

        return NextResponse.json({ success: true, value, audited });
    } catch (error: any) {
        console.error("[admin/clientes] PATCH failed:", error?.message ?? error);
        return NextResponse.json({ error: "write_failed" }, { status: 500 });
    }
}
