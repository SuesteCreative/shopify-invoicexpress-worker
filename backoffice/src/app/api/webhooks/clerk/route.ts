import { Webhook } from "svix";
import { headers } from "next/headers";
import { WebhookEvent } from "@clerk/nextjs/server";
import { getRequestContext } from "@cloudflare/next-on-pages";

export const runtime = "edge";

export async function POST(req: Request) {
    const WEBHOOK_SECRET = (process.env.CLERK_WEBHOOK_SECRET || (getRequestContext().env as any).CLERK_WEBHOOK_SECRET) as string;

    if (!WEBHOOK_SECRET) {
        console.error("Missing CLERK_WEBHOOK_SECRET");
        return new Response("Error: Missing secret", { status: 500 });
    }

    // Get the headers
    const headerPayload = await headers();
    const svix_id = headerPayload.get("svix-id");
    const svix_timestamp = headerPayload.get("svix-timestamp");
    const svix_signature = headerPayload.get("svix-signature");

    // If there are no headers, error out
    if (!svix_id || !svix_timestamp || svix_signature === null) {
        return new Response("Error: Missing svix headers", { status: 400 });
    }

    // Get the body
    const payload = await req.json();
    const body = JSON.stringify(payload);

    // Create a new Svix instance with your secret.
    const wh = new Webhook(WEBHOOK_SECRET);

    let evt: WebhookEvent;

    // Verify the payload with the headers
    try {
        evt = wh.verify(body, {
            "svix-id": svix_id,
            "svix-timestamp": svix_timestamp,
            "svix-signature": svix_signature,
        }) as WebhookEvent;
    } catch (err) {
        console.error("Error verifying webhook:", err);
        return new Response("Error: Verification failed", { status: 400 });
    }

    const { env } = getRequestContext();
    const db = (env as any).DB;
    const eventType = evt.type;

    if (eventType === "user.created" || eventType === "user.updated") {
        const { id, email_addresses, first_name, last_name, username } = evt.data;
        const email = email_addresses?.[0]?.email_address || null;
        const name = `${first_name || ""} ${last_name || ""}`.trim() || username || "User";
        // An invited extra user carries the membership in the invitation's public
        // metadata, which Clerk copies onto the user it creates.
        const invitedAccountId = (evt.data as any)?.public_metadata?.rioko_account_id as string | undefined;

        console.log(`[Clerk Webhook] Syncing user: ${email} (${id})`);

        await db.prepare(`
            INSERT INTO users (id, email, name, last_login)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
                email = ?,
                name = ?,
                last_login = CURRENT_TIMESTAMP
        `).bind(id, email, name, email, name).run();

        // Extra user joining an existing account (migration 0039): bind the
        // pending seat to the Clerk id that just signed up. Matching falls back to
        // the invited address, so someone who signs up on their own instead of
        // through the invitation link still lands in the right account.
        let joinedAccount: string | null = null;
        try {
            const pending: any = invitedAccountId
                ? await db.prepare(
                    "SELECT id, account_id FROM account_members WHERE account_id = ? AND status = 'pending' AND (member_user_id IS NULL OR member_user_id = ?) AND email = ? LIMIT 1"
                ).bind(invitedAccountId, id, (email || "").toLowerCase()).first()
                : await db.prepare(
                    "SELECT id, account_id FROM account_members WHERE status = 'pending' AND member_user_id IS NULL AND email = ? ORDER BY created_at ASC LIMIT 1"
                ).bind((email || "").toLowerCase()).first();

            if (pending) {
                await db.prepare(
                    "UPDATE account_members SET member_user_id = ?, status = 'active', accepted_at = CURRENT_TIMESTAMP WHERE id = ?"
                ).bind(id, pending.id).run();
                joinedAccount = pending.account_id;
                console.log(`[Clerk Webhook] ${email} joined account ${pending.account_id}`);
            }
        } catch (e: any) {
            // Migration not applied yet — plain sign-ups keep working.
            console.warn("[Clerk Webhook] membership bind skipped:", e?.message ?? e);
        }

        // On user.created: seed a trialing subscription row so the user has free
        // access until the cutoff. early_bird itself is seeded 0 — it is ON by
        // default only for Shopify→InvoiceXpress (decided at checkout by source),
        // and enabled manually by an admin for any other integration.
        // A member bills through the account that invited them, so they get no
        // subscription row of their own.
        if (eventType === "user.created" && !joinedAccount && !invitedAccountId) {
            const trialEnd = process.env.EARLY_BIRD_TRIAL_END
                || (env as any).EARLY_BIRD_TRIAL_END
                || "2026-08-01T00:00:00Z";
            const trialEndDate = new Date(trialEnd);
            if (!isNaN(trialEndDate.getTime()) && trialEndDate > new Date()) {
                await db.prepare(`
                    INSERT OR IGNORE INTO subscriptions (user_id, status, trial_end, early_bird, created_at, updated_at)
                    VALUES (?, 'trialing', ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `).bind(id, trialEndDate.toISOString()).run();
            }
        }
    }

    if (eventType === "user.deleted") {
        const { id } = evt.data;
        console.log(`[Clerk Webhook] Deleting user: ${id}`);

        // Deep delete
        await db.prepare("DELETE FROM integrations WHERE user_id = ?").bind(id).run();
        await db.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
    }

    return new Response("OK", { status: 200 });
}
