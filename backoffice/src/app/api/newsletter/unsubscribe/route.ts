import { NextRequest } from "next/server";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { verifyUnsubscribeToken } from "@/lib/newsletter-unsubscribe";

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

const INVALID = "Este link de cancelamento não é válido. Para deixar de receber as novidades da Rioko, responda a qualquer email nosso a pedir.";

export async function GET(req: NextRequest) {
    const email = await addressOf(req);
    if (!email) return page(400, "Link inválido", INVALID);

    const already = await env().DB.prepare("SELECT 1 FROM newsletter_optouts WHERE email = ?").bind(email).first();
    if (already) return page(200, "Subscrição cancelada", `${esc(email)} já não recebe as novidades da Rioko.`);

    return page(200, "Cancelar subscrição", `Deixar de receber as novidades da Rioko em ${esc(email)}?`, true);
}

export async function POST(req: NextRequest) {
    const email = await addressOf(req);
    if (!email) return page(400, "Link inválido", INVALID);

    const oneClick = (await req.text().catch(() => "")).includes("List-Unsubscribe=One-Click");
    await env().DB
        .prepare("INSERT OR IGNORE INTO newsletter_optouts (email, source) VALUES (?, ?)")
        .bind(email, oneClick ? "one-click" : "link")
        .run();
    console.warn(`[newsletter/unsubscribe] ${email} (${oneClick ? "one-click" : "link"})`);

    return page(200, "Subscrição cancelada", `${esc(email)} deixa de receber as novidades da Rioko.`);
}

function esc(s: string): string {
    return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** The Day skin the emails wear: cream, ink, one terracotta mark. */
function page(status: number, title: string, message: string, button = false): Response {
    const html = `<!doctype html>
<html lang="pt-PT">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · Rioko</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; box-sizing:border-box;
         background:#F6F3EE; color:#111111; font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif; }
  main { width:100%; max-width:440px; background:#FFFFFF; border-radius:18px; padding:32px; box-sizing:border-box; }
  .mark { margin:0 0 24px; font-weight:800; letter-spacing:-0.4px; }
  .mark span { margin-left:6px; background:#A8402E; color:#FFFFFF; border-radius:4px; padding:2px 6px; font-size:10px; font-family:ui-monospace,Menlo,Consolas,monospace; vertical-align:middle; }
  h1 { margin:0 0 12px; font-size:22px; letter-spacing:-0.3px; }
  p { margin:0 0 20px; color:#4B4B4B; line-height:1.5; }
  button { border:0; border-radius:999px; background:#111111; color:#FFFFFF; padding:13px 24px; font-size:15px; font-weight:600; cursor:pointer; }
  small { display:block; margin-top:20px; color:#8A857E; font-size:12px; line-height:1.5; }
</style>
</head>
<body>
<main>
  <p class="mark">RIOKO<span>2.0</span></p>
  <h1>${title}</h1>
  <p>${message}</p>
  ${button ? `<form method="post"><button type="submit">Cancelar subscrição</button></form>` : ""}
  <small>Os avisos de faturação e de serviço continuam a chegar, com ou sem esta subscrição.</small>
</main>
</body>
</html>`;
    return new Response(html, {
        status,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
}
