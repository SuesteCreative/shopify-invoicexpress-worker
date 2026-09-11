import type { Env } from "../env";
import { resolveConnectionContext, connectionLabelOf } from "../services/connection-context";
import { finalizeConnectionDrafts } from "./admin-connection";
import { loadRunInRow, tokenIsValid, type RunInRow } from "../services/run-in";

/**
 * The merchant's answer to the run-in question, on a link from an email.
 *
 * A worker route and not a backoffice page on purpose: the "yes" has to
 * finalize the drafts, and the finalizer lives here. Routing the click through
 * Clerk, a public Next route and back into this same handler would be three
 * more moving parts for the same two outcomes.
 *
 * No session. The token in the path is the whole authority — one connection,
 * 30 days, checked in constant time — which is the same trade the OAuth state
 * makes on the other side of the building.
 */

const SUPPORT_EMAIL = "pedro@kapta.pt";
const SUPPORT_CALL = "https://calendly.com/pedro-kapta/apoio-kapta";

function page(title: string, bodyHtml: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="pt-PT"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="robots" content="noindex">`
    + `<title>${title} · Rioko</title><style>`
    + `body{margin:0;background:#0b0d10;color:#e8eaed;font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif}`
    + `main{max-width:34rem;margin:0 auto;padding:3rem 1.25rem}`
    + `h1{font-size:1.4rem;line-height:1.3;margin:0 0 1rem}`
    + `p{margin:0 0 1rem;color:#b9bec6}a{color:#22d3ee}`
    + `.row{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:1.5rem}`
    + `button{font:inherit;border:0;border-radius:.6rem;padding:.75rem 1.1rem;cursor:pointer}`
    + `.yes{background:#22d3ee;color:#04212b}.no{background:#20242b;color:#e8eaed;border:1px solid #333a44}`
    + `</style></head><body><main>${bodyHtml}</main></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

const expired = () => page("Link expirado",
  `<h1>Este link já não é válido</h1><p>Expirou ou já foi usado. Escreva para `
  + `<a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> e resolvemos em dois minutos.</p>`, 404);

/** GET /runin/:token — the question. */
export async function renderRunInPage(env: Env, token: string): Promise<Response> {
  const row = await loadRunInRow(env, token);
  if (!tokenIsValid(row, token)) return expired();
  const label = connectionLabelOf("stripe_connect" as any, (row as RunInRow).destination_kind as any);

  if (row!.runin_answer === "yes") {
    return page("Já confirmado", `<h1>Já estava confirmado</h1><p>A ligação ${label} já emite documentos fechados. Não é preciso fazer mais nada.</p>`);
  }

  return page("Confirmar as primeiras faturas",
    `<h1>As primeiras faturas de ${label} estão como esperava?</h1>`
    + `<p>Estão todas em rascunho de propósito. Um documento fechado é comunicado à AT e só se corrige por nota de crédito, por isso preferimos perguntar antes.</p>`
    + `<p>Confirme o valor, o IVA e a identificação do cliente no seu programa de faturação.</p>`
    + `<form method="post" class="row">`
    + `<button class="yes" name="answer" value="yes">Está tudo certo, fechar as faturas</button>`
    + `<button class="no" name="answer" value="no">Há algo errado</button>`
    + `</form>`);
}

/** POST /runin/:token — the answer, and everything it sets in motion. */
export async function handleRunInAnswer(env: Env, token: string, answer: string): Promise<Response> {
  const row = await loadRunInRow(env, token);
  if (!tokenIsValid(row, token)) return expired();
  const conn = row as RunInRow;
  const label = connectionLabelOf("stripe_connect" as any, conn.destination_kind as any);
  const now = new Date().toISOString();

  if (answer !== "yes") {
    // The token is kept alive: "something is wrong" is the start of a
    // conversation, and the merchant may well come back and say yes after it.
    await env.DB.prepare("UPDATE connections SET runin_answer = 'no', updated_at = ? WHERE id = ?")
      .bind(now, conn.id).run();
    return page("Obrigado",
      `<h1>Não fechámos nada</h1>`
      + `<p>Os documentos de ${label} continuam em rascunho e vão continuar assim até nos dizer o contrário. Nada foi comunicado à AT.</p>`
      + `<p>Fale connosco: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> ou marque 15 minutos em <a href="${SUPPORT_CALL}">${SUPPORT_CALL}</a>.</p>`);
  }

  // The answer is recorded BEFORE the finalize runs. If a draft blows up
  // halfway through, the merchant has still answered and must not be asked
  // again — the leftovers are ours to chase, which is what the error page says.
  await env.DB.prepare("UPDATE connections SET runin_answer = 'yes', updated_at = ? WHERE id = ?")
    .bind(now, conn.id).run();

  const resolved = await resolveConnectionContext(env, {
    userId: conn.user_id, source: "stripe_connect" as any, destination: conn.destination_kind as any,
  });
  if (!resolved.ok) {
    return page("Confirmado",
      `<h1>Obrigado</h1><p>A confirmação ficou registada, mas não consegui abrir a ligação para fechar os rascunhos agora. `
      + `Vamos tratar disso e avisamos. Se preferir, escreva para <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>`);
  }

  // Oldest transaction first, because both destinations refuse a document dated
  // behind the last one already closed: finalizing the newest first raises the
  // series floor over everything beneath it.
  //
  // Paged, because `finalizeConnectionDrafts` caps a call at 100 rows — well
  // below Cloudflare's 1000-subrequest ceiling, since each row costs a GET,
  // often a PUT and a state change. A merchant who took a fortnight to answer
  // can easily have more than 100 waiting, and closing the first hundred while
  // reporting "done" would be a lie with a fiscal tail.
  //
  // Three pages is the ceiling one request can afford. Anything past that is
  // ours to finish with the admin tool, and the page says so rather than
  // pretending.
  let finalized = 0, errors = 0, afterRowid: number | null = null, hasMore = false;
  for (let pageNo = 0; pageNo < 3; pageNo++) {
    const summary: any = await finalizeConnectionDrafts(env, resolved.ctx, { limit: 100, after_rowid: afterRowid } as any);
    finalized += Number(summary?.finalized ?? 0);
    errors += Number(summary?.errors ?? 0);
    hasMore = !!summary?.has_more;
    afterRowid = summary?.next_after_rowid ?? null;
    if (!hasMore || afterRowid == null) break;
  }

  // No flag is flipped here, and that is deliberate. Enrolment already required
  // `auto_finalize === true` — the connection has always WANTED to certify, and
  // what stopped it was this answer being missing. Recording the "yes" above is
  // what lifts the hold; patching the flag as well would look like the grant and
  // be a no-op, which is worse than doing nothing.
  const closed = `${finalized} ${finalized === 1 ? "documento" : "documentos"}`;

  if (errors === 0 && !hasMore) {
    return page("Confirmado",
      `<h1>Feito</h1>`
      + `<p>Fechámos ${closed} de ${label}, do mais antigo para o mais recente.</p>`
      + `<p>A partir de agora as faturas seguintes são fechadas automaticamente, sem lhe perguntarmos outra vez.</p>`);
  }

  return page("Quase",
    `<h1>Obrigado — falta uma parte</h1>`
    + `<p>Fechámos ${closed}`
    + (errors ? `, mas ${errors} ${errors === 1 ? "ficou" : "ficaram"} por fechar` : "")
    + (hasMore ? " e ainda há mais à espera" : "")
    + `. Ninguém as vai fechar às escondidas.</p>`
    + `<p>As faturas novas passam a ser fechadas automaticamente; estas ficam connosco e vamos tratar delas. `
    + `Se quiser acelerar: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> ou <a href="${SUPPORT_CALL}">marcar 15 minutos</a>.</p>`);
}
