import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getRole, isAdmin } from "@/lib/admin";
import { resolveAccountUser } from "@/lib/account";
import { primaryConnectionKey } from "@/lib/stripe";
import { DEFAULT_CONNECTION_KEY } from "@/lib/subscription-key";
import { ixCredentialsPresent } from "@/lib/destination-credentials";
import { stripIntegrationSecrets } from "@/lib/redact";
import { auditFieldDiff } from "@/lib/config-audit";

export const runtime = "edge";

export async function GET(request: NextRequest) {
    try {
        const { userId } = await auth();
        let targetUserId = userId;

        if (!userId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        // Admin impersonation, then extra-user membership (migration 0039).
        targetUserId = await resolveAccountUser(request, userId);

        const { env } = getRequestContext();
        const db = (env as any).DB;

        if (!db) {
            console.error("D1 Binding 'DB' not found in env");
            return NextResponse.json({ error: "Database binding missing" }, { status: 500 });
        }

        const integration: any = await db
            .prepare("SELECT * FROM integrations WHERE user_id = ?")
            .bind(targetUserId)
            .first();

        // Also fetch the target user's metadata (correct under impersonation)
        const userRecord: any = await db
            .prepare("SELECT name, role, registration_completed FROM users WHERE id = ?")
            .bind(targetUserId)
            .first();

        const viewerRole = await getRole(userId);
        // True only for a real admin viewing someone else — a member working in
        // the account that invited them is not impersonating.
        const isImpersonating = targetUserId !== userId && (await isAdmin(userId));

        // `ix_authorized` is a verdict from the last time a key was tested, and
        // nothing ever withdrew it: Farracemota's credentials were cleared and
        // the flag stayed at 1, so their wizard showed InvoiceXpress in green
        // over an empty account name and every booking would have failed at the
        // proxy. A verdict about credentials that are no longer there is not a
        // verdict. Reported as false whenever either half is missing — the
        // stored row is left alone, so re-validating still restores it.
        const ixCredsPresent = ixCredentialsPresent(integration as any);

        // The credentials on this row never reach a browser.
        //
        // It spread the row whole, and the row is the account's Shopify Admin
        // token, its webhook secret, the InvoiceXpress key EVERY connection
        // files with, and the OAuth app secret (0053). Any signed-in member of
        // the account received all of it, read-only seats included.
        //
        // What comes back instead is `has_<column>` — whether the credential is
        // set, which is the only thing the wizards ever asked. The POST below
        // treats a blank as unchanged, so a form rendering with the field empty
        // cannot erase what is stored.
        return NextResponse.json({
            ...stripIntegrationSecrets(integration),
            ...(integration ? { ix_authorized: ixCredsPresent ? (integration as any).ix_authorized : 0 } : {}),
            _user_id: targetUserId,
            _user_name: userRecord?.name || null,
            _user_role: userRecord?.role || "user",
            _registration_completed: !!userRecord?.registration_completed,
            _viewer_role: viewerRole,
            _is_impersonating: isImpersonating
        });
    } catch (error: any) {
        console.error("D1 Error:", error);
        return NextResponse.json({ error: `Internal Server Error: ${error.message}` }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    try {
        const { userId } = await auth();
        let targetUserId = userId;

        if (!userId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        // Admin impersonation, then extra-user membership (migration 0039).
        targetUserId = await resolveAccountUser(request, userId);

        const body: any = await request.json();
        const { env } = getRequestContext();
        const db = (env as any).DB;

        if (!db) {
            console.error("D1 Binding 'DB' not found in env");
            return NextResponse.json({ error: "Database binding missing" }, { status: 500 });
        }

        const { shopify_domain, shopify_token, shopify_webhook_secret, shopify_api_version, ix_account_name, ix_api_key, ix_environment, ix_exemption_reason, vat_included, auto_finalize, shopify_authorized, webhooks_active, ix_document_type, ix_payment_term, ix_sequence_name, ix_retention_enabled, ix_retention, only_invoice_when_paid, ix_send_email, ix_email_subject, ix_email_body } = body;

        const clean_shopify_domain = shopify_domain ? shopify_domain.replace(/^https?:\/\//, "").replace(/\/$/, "") : null;

        // Retention: only persist a numeric value when the toggle is on AND the
        // number is in IX's accepted range (0–99.99). Otherwise store NULL so
        // the builder treats it as off.
        const retentionEnabledBit = ix_retention_enabled ? 1 : 0;
        let retentionValue: number | null = null;
        if (retentionEnabledBit === 1 && ix_retention !== undefined && ix_retention !== null && ix_retention !== "") {
            const parsed = typeof ix_retention === "number" ? ix_retention : parseFloat(String(ix_retention));
            if (!Number.isFinite(parsed) || parsed < 0 || parsed > 99.99) {
                return NextResponse.json({ error: "ix_retention must be a number between 0 and 99.99" }, { status: 400 });
            }
            retentionValue = parsed;
        } else if (ix_retention !== undefined && ix_retention !== null && ix_retention !== "") {
            // Toggle off but a value was sent — keep it so re-enabling restores
            // the last picked rate. Still validate to avoid junk in the DB.
            const parsed = typeof ix_retention === "number" ? ix_retention : parseFloat(String(ix_retention));
            if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 99.99) {
                retentionValue = parsed;
            }
        }

        // Customer-facing invoice email. Opt-in only: an absent field must never
        // flip it on, because turning it on starts sending mail to real buyers.
        // Subject/body are optional overrides of InvoiceXpress's own template —
        // empty string means "use the IX default", stored as NULL.
        const sendEmailBit = ix_send_email !== undefined ? (ix_send_email ? 1 : 0) : null;
        const emailSubject = ix_email_subject !== undefined ? (String(ix_email_subject).trim().slice(0, 200) || null) : undefined;
        const emailBody = ix_email_body !== undefined ? (String(ix_email_body).trim().slice(0, 1000) || null) : undefined;

        // Check if integration exists
        const existing: any = await db
            .prepare("SELECT * FROM integrations WHERE user_id = ?")
            .bind(targetUserId)
            .first();

        if (existing) {
            // Preserve existing shopify_authorized and webhooks_active if not explicitly provided or if forced
            let final_shopify_authorized = shopify_authorized !== undefined ? (shopify_authorized ? 1 : 0) : existing.shopify_authorized;
            let final_webhooks_active = webhooks_active !== undefined ? (webhooks_active ? 1 : 0) : existing.webhooks_active;

            // If webhooks_active is being set to 0, but it was admin-forced, keep it as 1
            if (final_webhooks_active === 0 && (existing.webhooks_forced_at || existing.webhooks_active === 1)) {
                // We trust the existing value more if we're just doing a generic 'save' from the dashboard
                final_webhooks_active = existing.webhooks_active;
            }

            // What the two IX columns will actually hold after this write, so the
            // authorisation flag below can be decided on the result rather than
            // on the request. A save that clears them has to withdraw the
            // verdict too, or the wizard goes on showing a green tick over an
            // account that can no longer issue anything.
            // BLANK MEANS UNCHANGED, for these two columns only.
            //
            // The rest of this UPDATE treats absent as unchanged and an empty
            // string as "clear it", which is right for a series name or an email
            // subject. It is wrong here: these two are the only credential the
            // account has for InvoiceXpress, they are shared by every connection
            // that files into it, and one wizard posting a blank — a form that
            // rendered before its GET returned, a page saved on a tab that had
            // been open since before the key was set — silently locked the
            // account out. Farracemota lost both this way on 2026-09-10, eleven
            // minutes after they were validated, and nothing anywhere said so.
            //
            // Clearing them is a deliberate act, and there is a deliberate place
            // for it: the admin console's reset, which is guarded and which also
            // withdraws `ix_authorized`.
            const statedIxAccount = typeof ix_account_name === "string" && ix_account_name.trim() ? ix_account_name : undefined;
            const statedIxKey = typeof ix_api_key === "string" && ix_api_key.trim() ? ix_api_key : undefined;
            // The Shopify pair, on the same rule, and now for a second reason:
            // the GET stopped sending these to the browser, so every wizard
            // POSTs them blank on any save that is not the one where they were
            // typed. Without this, opening the settings and changing a VAT
            // toggle would clear the shop's Admin token.
            const statedShopifyToken = typeof shopify_token === "string" && shopify_token.trim() ? shopify_token : undefined;
            const statedWebhookSecret = typeof shopify_webhook_secret === "string" && shopify_webhook_secret.trim() ? shopify_webhook_secret : undefined;
            const finalIxAccount = statedIxAccount ?? existing.ix_account_name;
            const finalIxKey = statedIxKey ?? existing.ix_api_key;
            const finalIxAuthorized =
                ixCredentialsPresent({ ix_account_name: finalIxAccount, ix_api_key: finalIxKey })
                    ? (existing.ix_authorized ?? 0)
                    : 0;

            await db
                .prepare(`
          UPDATE integrations
          SET shopify_domain = ?, shopify_token = ?, shopify_webhook_secret = ?, shopify_api_version = ?, ix_account_name = ?, ix_api_key = ?, ix_environment = ?, ix_exemption_reason = ?, vat_included = ?, auto_finalize = ?, shopify_authorized = ?, webhooks_active = ?, ix_document_type = ?, ix_payment_term = ?, ix_sequence_name = ?, ix_retention_enabled = ?, ix_retention = ?, only_invoice_when_paid = ?, ix_send_email = ?, ix_email_subject = ?, ix_email_body = ?, ix_authorized = ?, updated_at = CURRENT_TIMESTAMP
          WHERE user_id = ?
        `)
                // ABSENT MEANS UNCHANGED.
                //
                // This UPDATE writes all 21 columns every time, and the row is
                // shared: it is the Shopify integration's config AND the place a
                // Stripe->InvoiceXpress connection's credentials live. Four
                // wizards POST here with partial bodies, so saving one erased the
                // others' fields — `shopify_domain` and `shopify_token` to NULL,
                // the IX credentials to NULL, `ix_sequence_name` to NULL, the
                // exemption code back to M01. A merchant who saved the Stripe
                // wizard lost their shop's series and their webhook secret, and
                // nothing said so.
                //
                // Every value below now falls back to what is already stored.
                // `shopify_authorized` and `webhooks_active` already did this;
                // the rest did not.
                .bind(
                    shopify_domain !== undefined ? clean_shopify_domain : existing.shopify_domain,
                    statedShopifyToken ?? existing.shopify_token,
                    statedWebhookSecret ?? existing.shopify_webhook_secret,
                    shopify_api_version !== undefined ? (shopify_api_version || "2026-01") : (existing.shopify_api_version ?? "2026-01"),
                    finalIxAccount,
                    finalIxKey,
                    ix_environment !== undefined ? (ix_environment || "production") : (existing.ix_environment ?? "production"),
                    ix_exemption_reason !== undefined ? (ix_exemption_reason || "M01") : (existing.ix_exemption_reason ?? "M01"),
                    vat_included !== undefined ? (vat_included ? 1 : 0) : (existing.vat_included ?? 1),
                    auto_finalize !== undefined ? (auto_finalize ? 1 : 0) : (existing.auto_finalize ?? 0),
                    final_shopify_authorized,
                    final_webhooks_active,
                    ix_document_type !== undefined ? (ix_document_type || "invoice_receipt") : (existing.ix_document_type ?? "invoice_receipt"),
                    ix_payment_term !== undefined ? parseInt(String(ix_payment_term)) : (existing.ix_payment_term ?? 0),
                    ix_sequence_name !== undefined ? (ix_sequence_name || null) : existing.ix_sequence_name,
                    ix_retention_enabled !== undefined ? retentionEnabledBit : (existing.ix_retention_enabled ?? 0),
                    ix_retention !== undefined ? retentionValue : (existing.ix_retention ?? null),
                    only_invoice_when_paid !== undefined ? (only_invoice_when_paid ? 1 : 0) : (existing.only_invoice_when_paid ?? 0),
                    sendEmailBit ?? (existing.ix_send_email ?? 0),
                    emailSubject !== undefined ? emailSubject : (existing.ix_email_subject ?? null),
                    emailBody !== undefined ? emailBody : (existing.ix_email_body ?? null),
                    finalIxAuthorized,
                    targetUserId
                )
                .run();

            // The trail. This UPDATE is the only path in the product that can
            // change an account's InvoiceXpress credentials, and until now it
            // recorded nothing — which is why "who blanked Farracemota's key?"
            // has no answer. One row per column that actually changed, secrets
            // as presence markers only. Written after the UPDATE so a failed
            // save leaves no record of a change that did not happen.
            await auditFieldDiff(
                db,
                { userId: targetUserId, actor: userId, scope: "integrations" },
                existing,
                {
                    shopify_domain: shopify_domain !== undefined ? clean_shopify_domain : existing.shopify_domain,
                    // Same values the UPDATE above binds, or the trail records a
                    // clearing that never happened.
                    shopify_token: statedShopifyToken ?? existing.shopify_token,
                    shopify_webhook_secret: statedWebhookSecret ?? existing.shopify_webhook_secret,
                    ix_account_name: finalIxAccount,
                    ix_api_key: finalIxKey,
                    ix_authorized: finalIxAuthorized,
                    ix_environment: ix_environment !== undefined ? (ix_environment || "production") : (existing.ix_environment ?? "production"),
                    ix_sequence_name: ix_sequence_name !== undefined ? (ix_sequence_name || null) : existing.ix_sequence_name,
                    ix_document_type: ix_document_type !== undefined ? (ix_document_type || "invoice_receipt") : (existing.ix_document_type ?? "invoice_receipt"),
                    ix_exemption_reason: ix_exemption_reason !== undefined ? (ix_exemption_reason || "M01") : (existing.ix_exemption_reason ?? "M01"),
                    auto_finalize: auto_finalize !== undefined ? (auto_finalize ? 1 : 0) : (existing.auto_finalize ?? 0),
                    only_invoice_when_paid: only_invoice_when_paid !== undefined ? (only_invoice_when_paid ? 1 : 0) : (existing.only_invoice_when_paid ?? 0),
                    ix_send_email: sendEmailBit ?? (existing.ix_send_email ?? 0),
                },
            );
        } else {
            const id = crypto.randomUUID();
            await db
                .prepare(`
          INSERT INTO integrations (id, user_id, shopify_domain, shopify_token, shopify_webhook_secret, shopify_api_version, ix_account_name, ix_api_key, ix_environment, ix_exemption_reason, vat_included, auto_finalize, shopify_authorized, webhooks_active, ix_document_type, ix_payment_term, ix_sequence_name, ix_retention_enabled, ix_retention, only_invoice_when_paid, ix_send_email, ix_email_subject, ix_email_body)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
                .bind(
                    id,
                    targetUserId,
                    clean_shopify_domain,
                    shopify_token || null,
                    shopify_webhook_secret || null,
                    shopify_api_version || "2026-01",
                    ix_account_name || null,
                    ix_api_key || null,
                    ix_environment || "production",
                    ix_exemption_reason || "M01",
                    vat_included ? 1 : 0,
                    auto_finalize ? 1 : 0,
                    shopify_authorized ? 1 : 0,
                    webhooks_active ? 1 : 0,
                    ix_document_type || "invoice_receipt",
                    ix_payment_term !== undefined ? parseInt(String(ix_payment_term)) : 0,
                    ix_sequence_name || null,
                    retentionEnabledBit,
                    retentionValue,
                    only_invoice_when_paid ? 1 : 0,
                    sendEmailBit ?? 0,
                    emailSubject ?? null,
                    emailBody ?? null
                )
                .run();

            // A first save is a change too: from nothing to something. Logged
            // so the trail starts at the moment the account was configured,
            // not at its second edit.
            await auditFieldDiff(
                db,
                { userId: targetUserId, actor: userId, scope: "integrations" },
                null,
                {
                    shopify_domain: clean_shopify_domain,
                    ix_account_name: ix_account_name || null,
                    ix_api_key: ix_api_key || null,
                    ix_sequence_name: ix_sequence_name || null,
                },
            );
        }

        // Shopify merchants are early-bird by default: grant the free-access grace
        // until the cutoff. The gate reads early_bird + trial_end, so this is what
        // makes "Shopify → early bird by default" true in the DB (single source of
        // truth). Idempotent; the subscription row is normally seeded at signup.
        //
        // `admin_override_at` (migration 0028) opts a row out: once someone set the
        // dates by hand in Dev Mode, this save must not re-assert early_bird = 1 nor
        // restore the default cutoff. Rows without the marker behave exactly as before.
        const earlyBirdCutoff = (env as any).EARLY_BIRD_TRIAL_END || process.env.EARLY_BIRD_TRIAL_END || "2026-08-01T00:00:00Z";
        // Which connection the grant is for (0044). This route saves the legacy
        // row, so a shop domain names it outright; the Stripe wizard also posts
        // here for its IX credentials, and on an account with no shop that grant
        // belongs to whichever connection the account set up first.
        const earlyBirdKey = clean_shopify_domain
            ? DEFAULT_CONNECTION_KEY
            : await primaryConnectionKey(db, targetUserId);
        try {
            await db.prepare(`
                INSERT INTO subscriptions (user_id, connection_key, status, trial_end, early_bird, created_at, updated_at)
                VALUES (?, ?, 'trialing', ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                ON CONFLICT(user_id, connection_key) DO UPDATE SET
                    early_bird = CASE WHEN subscriptions.admin_override_at IS NULL
                                      THEN 1 ELSE subscriptions.early_bird END,
                    trial_end = CASE WHEN subscriptions.admin_override_at IS NULL
                                     THEN COALESCE(subscriptions.trial_end, excluded.trial_end)
                                     ELSE subscriptions.trial_end END,
                    updated_at = CURRENT_TIMESTAMP
            `).bind(targetUserId, earlyBirdKey, earlyBirdCutoff).run();
        } catch (e: any) {
            // Non-fatal: the integration was saved; early-bird grant is best-effort.
            console.error("[integrations] early-bird grant failed:", e?.message ?? e);
        }

        return NextResponse.json({ success: true });
    } catch (error: any) {
        console.error("D1 Error:", error);
        return NextResponse.json({ error: `Failed to save integration: ${error.message}` }, { status: 500 });
    }
}
