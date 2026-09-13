import { Webhook } from "svix";
import { headers } from "next/headers";
import { WebhookEvent } from "@clerk/nextjs/server";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { upsertUserRow } from "@/lib/client-code";

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

        // The row, and the customer number that comes with it. Both this and
        // /api/auth/sync used to carry their own copy of this statement; they
        // now share one, so neither can be the path that creates an account
        // without a code. See lib/client-code.
        await upsertUserRow(db, { id, email, name });

        // Extra user joining an existing account (migration 0039): bind the
        // pending seat to the Clerk id that just signed up. Matching falls back to
        // the invited address, so someone who signs up on their own instead of
        // through the invitation link still lands in the right account.
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
                console.log(`[Clerk Webhook] ${email} joined account ${pending.account_id}`);
            }
        } catch (e: any) {
            // Migration not applied yet — plain sign-ups keep working.
            console.warn("[Clerk Webhook] membership bind skipped:", e?.message ?? e);
        }

        // Signing up seeds no subscription row.
        //
        // It used to seed one on `shopify:invoicexpress` for everybody, which is
        // a pair most accounts never have: since 0044 the row names the
        // connection it pays for, and a merchant who only ever sets up
        // Lodgify→Moloni ended up owning a row for a pipe they do not run while
        // the pipe they do run had none. It granted nothing either — seeded with
        // `early_bird = 0`, the gate blocks that row on sight, exactly as it
        // blocks having no row at all — so nothing is lost by not writing it.
        //
        // The rows that matter are written where the pair is actually known: by
        // the checkout, by an admin link or invite claim, and by the early-bird
        // grant in /api/integrations.
    }

    if (eventType === "user.deleted") {
        const { id } = evt.data;
        console.log(`[Clerk Webhook] Deleting user: ${id}`);

        /**
         * Everything keyed to the account, not just the two tables this used to
         * remember.
         *
         * It deleted `integrations` and `users` and called itself a deep delete,
         * which left `connections` behind: a live pipe, still holding Stripe
         * credentials, still able to invoice, and belonging to a user row that
         * no longer existed — so invisible to every page that joins to `users`.
         * One such orphan was found in production on 11/09/2026, created the
         * same minute its account was.
         *
         * Deliberately kept: `processed_orders`, `document_events` and `logs`.
         * Those are the record of documents actually issued, and what made that
         * orphan explicable at all. Same rule the admin delete follows.
         *
         * Deliberately kept too, and for a different reason: `client_codes`.
         * It is the ledger of every customer number ever issued, and it exists
         * precisely so a deleted account's number is never handed to anybody
         * else — the documents above outlive the account and stay filed under
         * it. Adding it to this list for symmetry would put two companies'
         * history under one number. See lib/client-code.
         */
        for (const sql of [
            "DELETE FROM tag_routing_rules WHERE user_id = ?",
            "DELETE FROM product_mappings WHERE user_id = ?",
            "DELETE FROM connections WHERE user_id = ?",
            "DELETE FROM subscriptions WHERE user_id = ?",
            "DELETE FROM account_members WHERE account_id = ?",
            "DELETE FROM integrations WHERE user_id = ?",
            "DELETE FROM users WHERE id = ?",
        ]) {
            // A table missing from an older database must not abort the rest:
            // half a deletion is how the orphan above came to exist.
            try {
                await db.prepare(sql).bind(id).run();
            } catch (e: any) {
                console.warn(`[Clerk Webhook] ${sql.split(" ")[2]} cleanup skipped:`, e?.message ?? e);
            }
        }
    }

    return new Response("OK", { status: 200 });
}
