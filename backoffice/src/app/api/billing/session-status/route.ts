import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe";
import { resolveAccountUser } from "@/lib/account";

export const runtime = "edge";

/**
 * What became of an embedded Checkout Session.
 *
 * The embedded form ends by sending the merchant back to the onboarding page
 * with the session id, and the page has to say something before the webhook has
 * finished writing the subscription row. This answers that in one call.
 *
 * The session is only reported to the account that started it: the id travels in
 * a URL, so `client_reference_id` is checked against the caller's own account
 * rather than trusted on its own.
 */
export async function GET(req: NextRequest) {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const sessionId = req.nextUrl.searchParams.get("session_id");
    if (!sessionId) return NextResponse.json({ error: "Missing session_id" }, { status: 400 });

    const targetUserId = await resolveAccountUser(req, userId);

    try {
        const session = await getStripe().checkout.sessions.retrieve(sessionId);
        if (session.client_reference_id && session.client_reference_id !== targetUserId) {
            return NextResponse.json({ error: "Not found" }, { status: 404 });
        }
        return NextResponse.json({
            status: session.status,                 // open | complete | expired
            payment_status: session.payment_status, // paid | unpaid | no_payment_required
        });
    } catch (e: any) {
        return NextResponse.json({ error: e?.message ?? "Unknown error" }, { status: 502 });
    }
}
