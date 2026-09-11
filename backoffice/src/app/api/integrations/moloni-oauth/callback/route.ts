import { getRequestContext } from "@cloudflare/next-on-pages";
import { NextRequest, NextResponse } from "next/server";
import { RIOKO_CONFIG } from "@/lib/config";
import { isStripeConnectEnabled, resolveTargetUser } from "@/lib/stripe-connect";
import { exchangeMoloniCode, findPendingMoloniConnection, moloniCallbackUri } from "@/lib/moloni-oauth";
import { resolveReturnPath, RETURN_SLUG_WIZARD } from "@/lib/oauth-return";

export const runtime = "edge";

/**
 * Where Moloni sends every merchant back, whichever connection they were
 * authorising. One URL for the whole product, because a Moloni developer app
 * holds exactly one — see `@/lib/moloni-oauth` for what the per-connection URL
 * cost. The sibling `[connectionId]` route still answers for apps registered
 * with the old one.
 */
export async function GET(request: NextRequest) {
    // Which page the merchant started on. Only known once the row is read, so
    // until then the wizard is the answer. Request-local: a module variable
    // would leak one merchant's page into the next request's redirect.
    let returnPath = resolveReturnPath(RETURN_SLUG_WIZARD, "pt");

    const backToWizard = (status: string, detail?: string) => {
        const url = new URL(`${RIOKO_CONFIG.appUrl}${returnPath}`);
        url.searchParams.set("moloni", status);
        if (detail) url.searchParams.set("detail", detail.slice(0, 200));
        return NextResponse.redirect(url.toString(), 302);
    };

    const params = request.nextUrl.searchParams;
    const code = params.get("code");
    const error = params.get("error");

    if (error) return backToWizard("denied", params.get("error_description") ?? error);
    if (!code) return backToWizard("error", "O Moloni não devolveu o código de autorização");

    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return backToWizard("error", "A sessão expirou. Entre outra vez e repita.");

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return backToWizard("error", "Database binding missing");

    const row = await findPendingMoloniConnection(db, authResult.targetUserId, params.get("state"));
    if (!row) {
        return backToWizard("error", "A autorização expirou ou já foi usada. Carregue outra vez em autorizar.");
    }

    // The kill switch is Stripe Connect's, and it is checked here rather than at
    // the door: which connection this code belongs to is only known once the row
    // is read. A Lodgify merchant's Moloni authorisation is none of its business.
    if (row.source_kind === "stripe_connect" && !isStripeConnectEnabled()) {
        return backToWizard("error", "Integração indisponível.");
    }

    const startedOn = row.source_config_json ? JSON.parse(row.source_config_json) : {};
    returnPath = resolveReturnPath(startedOn.return_slug, startedOn.return_locale);

    const result = await exchangeMoloniCode(db, row, code, moloniCallbackUri());
    if (!result.ok) return backToWizard("error", result.detail);

    return backToWizard("connected");
}
