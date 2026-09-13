import { NextRequest } from "next/server";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { verifyUnsubscribeToken } from "@/lib/newsletter-unsubscribe";
import { asLang, type Lang } from "@/lib/user-language";

export const runtime = "edge";

/**
 * Where a newsletter's "Cancelar subscrição" leads.
 *
 * Public (see middleware): the signed token is the authority, and requiring a
 * session would shut out exactly the people clicking this.
 *
 * GET only shows a button; POST is what records the opt-out. Link scanners
 * (Outlook Safe Links, company mail gateways) fetch every URL in a message, and
 * a GET that unsubscribed would opt people out without them ever clicking. POST
 * is also what Gmail and Outlook send for the one-click List-Unsubscribe header.
 *
 * Written in the language of whoever holds the address, resolved off the address
 * itself: there is no session here, and an English client must not be sent to a
 * Portuguese page by the last email they will ever get from us.
 */

function env(): any {
    try {
        return getRequestContext().env;
    } catch {
        return {};
    }
}

async function addressOf(req: NextRequest): Promise<string | null> {
    const secret = env().ADMIN_API_KEY || process.env.ADMIN_API_KEY || "";
    return verifyUnsubscribeToken(secret, req.nextUrl.searchParams.get("t") ?? "");
}

/** The account that holds this address, if any. A typed-in recipient with no
 *  account reads Portuguese, which is what the campaign was written in. */
async function languageOf(email: string | null): Promise<Lang> {
    if (!email) return "pt";
    try {
        const row: any = await env().DB
            .prepare("SELECT language FROM users WHERE lower(email) = lower(?) LIMIT 1")
            .bind(email).first();
        return asLang(row?.language);
    } catch {
        return "pt";
    }
}

const COPY = {
    pt: {
        invalidTitle: "Link inválido",
        invalid: "Este link de cancelamento não é válido. Para deixar de receber as novidades da Rioko, responda a qualquer email nosso a pedir.",
        doneTitle: "Subscrição cancelada",
        already: (e: string) => `${e} já não recebe as novidades da Rioko.`,
        askTitle: "Cancelar subscrição",
        ask: (e: string) => `Deixar de receber as novidades da Rioko em ${e}?`,
        done: (e: string) => `${e} deixa de receber as novidades da Rioko.`,
        button: "Cancelar subscrição",
        note: "Os avisos de faturação e de serviço continuam a chegar, com ou sem esta subscrição.",
        htmlLang: "pt-PT",
    },
    en: {
        invalidTitle: "Invalid link",
        invalid: "This unsubscribe link is not valid. To stop receiving Rioko news, reply to any email of ours and say so.",
        doneTitle: "Unsubscribed",
        already: (e: string) => `${e} no longer receives Rioko news.`,
        askTitle: "Unsubscribe",
        ask: (e: string) => `Stop sending Rioko news to ${e}?`,
        done: (e: string) => `${e} will no longer receive Rioko news.`,
        button: "Unsubscribe",
        note: "Billing and service notices keep arriving, with or without this subscription.",
        htmlLang: "en",
    },
} as const;

export async function GET(req: NextRequest) {
    const email = await addressOf(req);
    const c = COPY[await languageOf(email)];
    if (!email) return page(400, c.invalidTitle, c.invalid, c);

    const already = await env().DB.prepare("SELECT 1 FROM newsletter_optouts WHERE email = ?").bind(email).first();
    if (already) return page(200, c.doneTitle, c.already(esc(email)), c);

    return page(200, c.askTitle, c.ask(esc(email)), c, true);
}

export async function POST(req: NextRequest) {
    const email = await addressOf(req);
    const c = COPY[await languageOf(email)];
    if (!email) return page(400, c.invalidTitle, c.invalid, c);

    const oneClick = (await req.text().catch(() => "")).includes("List-Unsubscribe=One-Click");
    await env().DB
        .prepare("INSERT OR IGNORE INTO newsletter_optouts (email, source) VALUES (?, ?)")
        .bind(email, oneClick ? "one-click" : "link")
        .run();
    console.warn(`[newsletter/unsubscribe] ${email} (${oneClick ? "one-click" : "link"})`);

    return page(200, c.doneTitle, c.done(esc(email)), c);
}

function esc(s: string): string {
    return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** The Day skin the emails wear: cream, ink, one terracotta mark. */
function page(
    status: number,
    title: string,
    message: string,
    copy: (typeof COPY)[Lang],
    button = false,
): Response {
    const html = `<!doctype html>
<html lang="${copy.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · Rioko</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; box-sizing:border-box;
         background:#F6F3EE; color:#111111; font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif; }
  main { width:100%; max-width:440px; background:#FFFFFF; border-radius:18px; padding:32px; box-sizing:border-box; }
  .mark { display:block; margin:0 0 24px; width:108px; height:auto; border:0; }
  h1 { margin:0 0 12px; font-size:22px; letter-spacing:-0.3px; }
  p { margin:0 0 20px; color:#4B4B4B; line-height:1.5; }
  button { border:0; border-radius:999px; background:#111111; color:#FFFFFF; padding:13px 24px; font-size:15px; font-weight:600; cursor:pointer; }
  small { display:block; margin-top:20px; color:#8A857E; font-size:12px; line-height:1.5; }
</style>
</head>
<body>
<main>
  <!-- The official wordmark, the file the site itself serves. This page used to
       draw it: the letters in Arial and a terracotta chip beside them, which is
       a lookalike and not the logo. Same origin, so it needs no absolute URL. -->
  <img class="mark" src="/images/rioko2-logo-light2.png" width="108" height="22" border="0" alt="Rioko 2.0" />
  <h1>${title}</h1>
  <p>${message}</p>
  ${button ? `<form method="post"><button type="submit">${copy.button}</button></form>` : ""}
  <small>${copy.note}</small>
</main>
</body>
</html>`;
    return new Response(html, {
        status,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
}
