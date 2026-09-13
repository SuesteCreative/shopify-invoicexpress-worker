import { getRequestContext } from "@cloudflare/next-on-pages";
import { NextRequest, NextResponse } from "next/server";
import { getAccountContext } from "@/lib/account";
import { syncAccountStripeLocale } from "@/lib/stripe-locale";
import { asLang, isLang, readAccountLanguage } from "@/lib/user-language";

export const runtime = "edge";

/**
 * The language this account is written to in: the dashboard, its toasts, and
 * every email we send.
 *
 * Written on the ACCOUNT, not on whoever is signed in — it is the client's
 * setting, shown on their customer record, and an invited member switching it
 * switches it for the account they work in. That is deliberate: one account, one
 * language, wherever it is addressed.
 *
 * Refused while impersonating. An operator reading a client's screen in
 * Portuguese must not silently overwrite the English that client asked for; the
 * operator has the selector on the customer record for a change they mean.
 */
export async function GET(request: NextRequest) {
    const ctx = await getAccountContext(request);
    if (!ctx) return new NextResponse("Unauthorized", { status: 401 });

    const db = (getRequestContext().env as any)?.DB;
    if (!db) return NextResponse.json({ error: "No database" }, { status: 500 });

    return NextResponse.json({ language: await readAccountLanguage(db, ctx.authUserId) });
}

export async function POST(request: NextRequest) {
    const ctx = await getAccountContext(request);
    if (!ctx) return new NextResponse("Unauthorized", { status: 401 });

    const body = (await request.json().catch(() => ({}))) as { language?: string };
    if (!isLang(body.language)) {
        return NextResponse.json({ error: "unknown_language" }, { status: 400 });
    }

    if (ctx.impersonating) {
        // Said out loud rather than pretended: the screen still changes for the
        // operator, the record does not.
        return NextResponse.json({ ok: true, persisted: false, language: body.language });
    }

    const db = (getRequestContext().env as any)?.DB;
    if (!db) return NextResponse.json({ error: "No database" }, { status: 500 });

    const result = await db.prepare("UPDATE users SET language = ? WHERE id = ?")
        .bind(asLang(body.language), ctx.accountId).run()
        .catch((e: any) => {
            console.error("[language] Could not save the choice:", e?.message);
            return null;
        });
    if (!result) return NextResponse.json({ error: "write_failed" }, { status: 500 });

    // Stripe writes to this client too — receipts, dunning, the hosted invoice
    // page — and it reads the language off the Customer, not off us.
    await syncAccountStripeLocale(db, ctx.accountId, asLang(body.language));

    return NextResponse.json({ ok: true, persisted: true, language: body.language });
}
