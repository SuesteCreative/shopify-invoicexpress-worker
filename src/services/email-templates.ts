/**
 * Incident email templates. Each function returns `{subject, html}` ready for
 * `sendEmail()`. Plain-text version is derived automatically by stripping HTML.
 *
 * Design notes
 * - Email clients are picky. Layout uses tables (Outlook needs them), all CSS
 *   is inline, no <style> blocks. PNG logos hosted on rioko.online (SVG fails
 *   in Gmail/Outlook).
 * - Dark gradient header (matches dashboard glassmorphism aesthetic), white
 *   body card for readability. Blue (#38bdf8) and purple (#a855f7) accents
 *   pulled from globals.css.
 */

export type IncidentKind =
  | "auth_failure_destination"
  | "auth_failure_source"
  | "destination_reject"
  | "normalize_fail"
  | "nif_invalid"
  | "subscription_inactive"
  | "queue_retry_exhausted"
  | "webhook_invalid_signature"
  | "vies_unconfirmed";

export type Severity = "info" | "warning" | "error" | "critical";

export interface IncidentTemplateInput {
  merchantName?: string;
  connectionLabel?: string;            // e.g. "Stripe → InvoiceXpress"
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  summary: string;
  detail?: any;
  affectedIds?: string[];
  helpUrl?: string;
  severity?: Severity;
  /** Override the dashboard host used for help/CTA links. */
  dashboardUrl?: string;
}

export interface RenderedTemplate {
  subject: string;
  html: string;
}

// Dark-first palette. Mirrors the dashboard's glassmorphism aesthetic and
// sidesteps Gmail mobile dark-mode auto-inversion (which turns white→gray
// while leaving dark text dark — invisible on the resulting mid-gray card).
const BRAND = {
  pageBg: "#0a0f1c",                                                       // outside the card
  cardBg: "#0f172a",                                                       // card body
  cardBgAlt: "#111a2e",                                                    // footer / meta zone
  bgGradient: "linear-gradient(135deg, #1e293b 0%, #0f172a 50%, #1e1b4b 100%)",
  text: "#f1f5f9",                                                         // primary text
  textStrong: "#fefefe",
  muted: "#94a3b8",
  border: "#1e2a44",
  borderSubtle: "#334155",
  chipBg: "#1e293b",
  blue: "#38bdf8",
  purple: "#a855f7",
  info: "#38bdf8",
  warning: "#fbbf24",
  error: "#f87171",
  critical: "#ef4444",
};

// Wide PNG logo hosted on rioko.online (Gmail's image proxy reliably fetches
// from there; workers.dev subdomains are unreliable, inline base64 ≥ ~10KB
// gets stripped on Gmail web, and SVG data URIs are stripped entirely).
const LOGO_WHITE = "https://rioko.online/images/rioko2-logo.png";
const DEFAULT_DASHBOARD = "https://rioko.online";
const DEFAULT_HELP_URL = "mailto:suporte@kapta.pt";

function escapeHtml(s: string): string {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function severityColor(s: Severity | undefined): string {
  return s === "critical" ? BRAND.critical
    : s === "error" ? BRAND.error
    : s === "warning" ? BRAND.warning
    : BRAND.info;
}

function severityLabelPT(s: Severity | undefined): string {
  return s === "critical" ? "Crítico"
    : s === "error" ? "Erro"
    : s === "warning" ? "Aviso"
    : "Informação";
}

// ──────────────────────────────────────────────────────────────────────────
// Layout primitives
// ──────────────────────────────────────────────────────────────────────────

function shell(opts: {
  title: string;
  severity?: Severity;
  preheader?: string;
  bodyHtml: string;
  helpUrl: string;
  dashboardUrl: string;
  merchantName?: string;
  connectionLabel?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
}): string {
  const accent = severityColor(opts.severity);
  const severityChip = opts.severity ? `
    <span style="display:inline-block;background:${accent};color:#fff;font-size:11px;font-weight:600;letter-spacing:0.5px;text-transform:uppercase;padding:4px 10px;border-radius:12px;vertical-align:middle">
      ${severityLabelPT(opts.severity)}
    </span>` : "";

  const occurChip = opts.occurrences > 1 ? `
    <span style="display:inline-block;background:rgba(251,191,36,0.18);color:#fbbf24;border:1px solid rgba(251,191,36,0.35);font-size:11px;font-weight:600;padding:3px 9px;border-radius:12px;margin-left:6px;vertical-align:middle">
      ${opts.occurrences}× ocorrências
    </span>` : "";

  const connectionChip = opts.connectionLabel ? `
    <div style="margin-top:8px">
      <span style="display:inline-block;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);color:#cbd5e1;font-size:12px;font-weight:500;padding:4px 10px;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">
        ${escapeHtml(opts.connectionLabel)}
      </span>
    </div>` : "";

  const merchantLine = opts.merchantName ? `
    <p style="margin:6px 0 0;color:#94a3b8;font-size:13px">
      ${escapeHtml(opts.merchantName)}
    </p>` : "";

  return `<!doctype html>
<html lang="pt-PT">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark only">
  <meta name="supported-color-schemes" content="dark only">
  <title>${escapeHtml(opts.title)}</title>
  <style>
    /* Gmail mobile (Android + iOS) injects data-ogsc on body / data-ogsb on bg-styled elements
       when dark mode is on, then rewrites colors. Targeting those attributes lets us force
       the colors we want and survive Gmail's rewrite. */
    /* Gmail mobile dark-mode auto-inverts pure #ffffff text on dark bg (breaks our
       intentionally dark header). Near-white #fefefe escapes the heuristic — Gmail's
       color rewriter only targets exact pure white/black. */
    [data-ogsc] .force-white, [data-ogsc] .force-white * { color: #fefefe !important; }
    [data-ogsc] .force-muted, [data-ogsc] .force-muted * { color: #94a3b8 !important; }
    [data-ogsc] .force-blue { color: #38bdf8 !important; }
    [data-ogsb] .header-bg { background-color: #1e1b4b !important; background-image: ${BRAND.bgGradient} !important; }
    [data-ogsb] .card-bg { background-color: ${BRAND.cardBg} !important; }
    [data-ogsb] .footer-bg { background-color: ${BRAND.cardBgAlt} !important; }

    /* Apple Mail + iOS Mail + clients honoring prefers-color-scheme */
    @media (prefers-color-scheme: dark) {
      .force-white, .force-white * { color: #fefefe !important; }
      .force-muted, .force-muted * { color: #94a3b8 !important; }
      .header-bg { background-color: #1e1b4b !important; }
      .card-bg { background-color: ${BRAND.cardBg} !important; }
      .footer-bg { background-color: ${BRAND.cardBgAlt} !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:${BRAND.pageBg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:${BRAND.text};-webkit-font-smoothing:antialiased">
  <!-- preheader (hidden, shows in inbox preview) -->
  ${opts.preheader ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escapeHtml(opts.preheader)}</div>` : ""}

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND.pageBg}" style="background-color:${BRAND.pageBg};padding:32px 16px">
    <tr>
      <td align="center" bgcolor="${BRAND.pageBg}">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND.cardBg}" style="max-width:600px;width:100%;background-color:${BRAND.cardBg};border-radius:14px;overflow:hidden">
          <!-- header bar — bgcolor + classed for Gmail mobile dark-mode override -->
          <tr>
            <td class="header-bg" bgcolor="#1e1b4b" style="background-color:#1e1b4b;background-image:${BRAND.bgGradient};padding:28px 32px 24px;position:relative">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td valign="middle">
                    <img src="${LOGO_WHITE}" alt="Rioko 2.0" width="140" height="auto" style="display:block;border:0;outline:none;text-decoration:none;max-width:140px;height:auto">
                  </td>
                  <td valign="middle" align="right">
                    ${severityChip}${occurChip}
                  </td>
                </tr>
              </table>
              <div class="force-white" style="margin-top:20px">
                <h1 class="force-white" style="margin:0;color:#fefefe;font-size:22px;font-weight:600;letter-spacing:-0.3px;line-height:1.3;mso-line-height-rule:exactly">
                  <span style="color:#fefefe">${escapeHtml(opts.title)}</span>
                </h1>
                ${merchantLine}
                ${connectionChip}
              </div>
              <!-- severity accent stripe -->
              <div style="height:3px;width:100%;background-color:${BRAND.blue};background-image:linear-gradient(90deg, ${BRAND.blue}, ${BRAND.purple});margin-top:24px"></div>
            </td>
          </tr>

          <!-- body card -->
          <tr>
            <td class="card-bg" bgcolor="${BRAND.cardBg}" style="background-color:${BRAND.cardBg};padding:32px;color:${BRAND.text}">
              ${opts.bodyHtml}
            </td>
          </tr>

          <!-- meta row -->
          <tr>
            <td class="card-bg" bgcolor="${BRAND.cardBg}" style="background-color:${BRAND.cardBg};padding:0 32px 24px">
              <hr style="border:none;border-top:1px solid ${BRAND.border};margin:0 0 16px">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:12px;color:${BRAND.muted}">
                <tr>
                  <td style="color:${BRAND.muted}"><font color="${BRAND.muted}">Primeira ocorrência</font></td>
                  <td align="right" style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:${BRAND.muted}"><font color="${BRAND.muted}">${escapeHtml(opts.firstSeenAt)}</font></td>
                </tr>
                <tr>
                  <td style="padding-top:4px;color:${BRAND.muted}"><font color="${BRAND.muted}">Última ocorrência</font></td>
                  <td align="right" style="padding-top:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:${BRAND.muted}"><font color="${BRAND.muted}">${escapeHtml(opts.lastSeenAt)}</font></td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- footer -->
          <tr>
            <td class="footer-bg" bgcolor="${BRAND.cardBgAlt}" style="background-color:${BRAND.cardBgAlt};padding:24px 32px;border-top:1px solid ${BRAND.border};text-align:center">
              <p class="force-muted" style="margin:0;font-size:13px;color:${BRAND.muted};line-height:1.6">
                <font color="${BRAND.muted}">Precisa de ajuda?</font>
                <a href="${escapeHtml(opts.helpUrl)}" class="force-blue" style="color:${BRAND.blue};text-decoration:none;font-weight:500"><font color="${BRAND.blue}">Contacte a equipa Rioko 2.0</font></a>
                <font color="${BRAND.muted}">·</font>
                <a href="${escapeHtml(opts.dashboardUrl)}" class="force-blue" style="color:${BRAND.blue};text-decoration:none;font-weight:500"><font color="${BRAND.blue}">Abrir painel</font></a>
              </p>
              <p class="force-muted" style="margin:12px 0 0;font-size:11px;color:${BRAND.muted}">
                <font color="${BRAND.muted}">Rioko 2.0 by <a href="https://kapta.pt" style="color:${BRAND.muted};text-decoration:underline"><font color="${BRAND.muted}">Kapta</font></a> · Notificação automática · Não responda a este email</font>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function sectionTitle(text: string): string {
  return `<h2 style="margin:0 0 12px;font-size:14px;font-weight:600;letter-spacing:0.3px;text-transform:uppercase;color:${BRAND.muted}">${escapeHtml(text)}</h2>`;
}

function paragraph(text: string, opts: { strong?: boolean } = {}): string {
  return `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${BRAND.text}${opts.strong ? ";font-weight:500" : ""}">${text}</p>`;
}

function calloutBox(headingText: string, html: string, accent = BRAND.blue): string {
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.chipBg};border-left:3px solid ${accent};border-radius:6px;margin:0 0 20px">
    <tr>
      <td style="padding:14px 18px">
        <p style="margin:0 0 6px;font-size:12px;font-weight:600;letter-spacing:0.4px;text-transform:uppercase;color:${accent}">${escapeHtml(headingText)}</p>
        <div style="font-size:14px;line-height:1.6;color:${BRAND.text}">${html}</div>
      </td>
    </tr>
  </table>`;
}

function stepsList(steps: string[]): string {
  return `
  ${sectionTitle("O que tentar primeiro")}
  <ol style="margin:0 0 24px;padding-left:20px;font-size:14px;color:${BRAND.text};line-height:1.7">
    ${steps.map(s => `<li style="margin-bottom:6px">${escapeHtml(s)}</li>`).join("")}
  </ol>`;
}

function affectedIdsBlock(ids?: string[]): string {
  if (!ids || ids.length === 0) return "";
  const shown = ids.slice(0, 10);
  const more = ids.length > 10 ? `<div style="font-size:12px;color:${BRAND.muted};margin-top:8px">… e mais ${ids.length - 10}</div>` : "";
  const chips = shown.map(id =>
    `<span style="display:inline-block;background:${BRAND.chipBg};border:1px solid ${BRAND.borderSubtle};color:${BRAND.text};font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;padding:4px 8px;border-radius:5px;margin:0 4px 4px 0">${escapeHtml(id)}</span>`
  ).join("");
  return `
  ${sectionTitle("Encomendas / pagamentos afetados")}
  <div style="margin-bottom:24px">${chips}${more}</div>`;
}

function detailBlock(detail: any): string {
  if (detail == null) return "";
  const json = JSON.stringify(detail, null, 2);
  return `
  ${sectionTitle("Detalhe técnico")}
  <pre style="margin:0 0 24px;padding:14px;background:#070d1a;color:#cbd5e1;border:1px solid ${BRAND.border};border-radius:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.55;overflow-x:auto;white-space:pre-wrap;word-break:break-word">${escapeHtml(json)}</pre>`;
}

function ctaButton(label: string, href: string): string {
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 0">
    <tr>
      <td style="background:${BRAND.blue};border-radius:8px">
        <a href="${escapeHtml(href)}" style="display:inline-block;padding:10px 22px;color:#0a0f1c;font-size:14px;font-weight:600;text-decoration:none;font-family:inherit">${escapeHtml(label)}</a>
      </td>
    </tr>
  </table>`;
}

// ──────────────────────────────────────────────────────────────────────────
// Per-kind templates
// ──────────────────────────────────────────────────────────────────────────

function baseInput(input: IncidentTemplateInput) {
  return {
    helpUrl: input.helpUrl ?? DEFAULT_HELP_URL,
    dashboardUrl: input.dashboardUrl ?? DEFAULT_DASHBOARD,
    merchantName: input.merchantName,
    connectionLabel: input.connectionLabel,
    firstSeenAt: input.firstSeenAt,
    lastSeenAt: input.lastSeenAt,
    occurrences: input.occurrences,
    severity: input.severity,
  };
}

export function tplAuthFailureDestination(input: IncidentTemplateInput): RenderedTemplate {
  const body = `
    ${paragraph("O Rioko 2.0 não conseguiu autenticar-se com o sistema de faturação. <strong>Nenhuma factura nova será emitida</strong> enquanto isto não for resolvido.", { strong: true })}
    ${calloutBox("Causa provável", "A chave de API expirou, foi rodada ou o utilizador foi removido.", BRAND.error)}
    ${stepsList([
      "Abra as definições da conta de faturação e verifique se a chave API está ativa.",
      "No Rioko 2.0, em Integrações → reconectar, cole a nova chave.",
      "Reexecute manualmente as encomendas afetadas em Dev Mode.",
    ])}
    ${affectedIdsBlock(input.affectedIds)}
    ${ctaButton("Abrir Integrações", `${input.dashboardUrl ?? DEFAULT_DASHBOARD}/integrations`)}
  `;
  return {
    subject: "[Rioko 2.0] Falha de autenticação no sistema de faturação",
    html: shell({
      title: "Falha de autenticação no sistema de faturação",
      preheader: "Nenhuma factura nova será emitida até resolver.",
      bodyHtml: body,
      ...baseInput(input),
    }),
  };
}

export function tplAuthFailureSource(input: IncidentTemplateInput): RenderedTemplate {
  const body = `
    ${paragraph("O Rioko 2.0 não conseguiu autenticar-se com Shopify/Stripe ao processar webhooks.")}
    ${calloutBox("Causa provável", "Token revogado, sessão expirada ou conta suspensa.", BRAND.error)}
    ${stepsList([
      "Verifique se a app Rioko 2.0 continua autorizada na sua loja.",
      "Reconecte a fonte através do Rioko 2.0 (Integrações → reconectar).",
      "Após reconectar, reexecute as encomendas em falta em Dev Mode.",
    ])}
    ${affectedIdsBlock(input.affectedIds)}
    ${ctaButton("Abrir Integrações", `${input.dashboardUrl ?? DEFAULT_DASHBOARD}/integrations`)}
  `;
  return {
    subject: "[Rioko 2.0] Falha de autenticação na fonte de vendas",
    html: shell({
      title: "Falha de autenticação na fonte de vendas",
      preheader: "Webhooks rejeitados — necessário reconectar.",
      bodyHtml: body,
      ...baseInput(input),
    }),
  };
}

export function tplDestinationReject(input: IncidentTemplateInput): RenderedTemplate {
  const body = `
    ${paragraph(escapeHtml(input.summary))}
    ${calloutBox("Causa provável", "Dados inválidos: NIF incorreto, código de imposto inexistente, sequência sem permissões, ou cliente em estado inconsistente.", BRAND.error)}
    ${stepsList([
      "Abra o documento no sistema de faturação e veja a mensagem de erro detalhada.",
      "Corrija os dados do cliente ou do produto, conforme aplicável.",
      "Reexecute a encomenda em Dev Mode após a correcção.",
    ])}
    ${affectedIdsBlock(input.affectedIds)}
    ${detailBlock(input.detail)}
    ${ctaButton("Abrir Dev Mode", `${input.dashboardUrl ?? DEFAULT_DASHBOARD}/superadmin`)}
  `;
  return {
    subject: "[Rioko 2.0] Documento rejeitado pelo sistema de faturação",
    html: shell({
      title: "Documento rejeitado pelo sistema de faturação",
      preheader: "Dados inválidos impediram a emissão da factura.",
      bodyHtml: body,
      ...baseInput(input),
    }),
  };
}

export function tplNormalizeFail(input: IncidentTemplateInput): RenderedTemplate {
  const body = `
    ${paragraph(escapeHtml(input.summary))}
    ${calloutBox("Causa provável", "O serviço de normalização devolveu um erro transitório ou a encomenda tem um formato inesperado.", BRAND.warning)}
    ${stepsList([
      "Aguarde alguns minutos e reexecute em Dev Mode.",
      "Se persistir, contacte o suporte com o ID da encomenda.",
    ])}
    ${affectedIdsBlock(input.affectedIds)}
  `;
  return {
    subject: "[Rioko 2.0] Falha a ler dados da venda",
    html: shell({
      title: "Falha a ler dados da venda",
      bodyHtml: body,
      ...baseInput(input),
    }),
  };
}

export function tplViesUnconfirmed(input: IncidentTemplateInput): RenderedTemplate {
  const body = `
    ${paragraph(escapeHtml(input.summary))}
    ${calloutBox("Acção necessária", "Validar o NIF/VAT do cliente manualmente em <a href=\"https://viesvalidation.com/pt/\" target=\"_blank\" style=\"color:#38bdf8\">viesvalidation.com/pt</a> e aprovar ou rejeitar no dashboard.", BRAND.warning)}
    ${stepsList([
      "Abrir o link do VIES (viesvalidation.com/pt) num separador novo.",
      "Confirmar se o NIF/VAT do comprador é válido nesse estado-membro.",
      "Aprovar para aplicar reverse charge (IVA 0%) ou rejeitar para emitir como B2C com IVA normal.",
    ])}
    ${affectedIdsBlock(input.affectedIds)}
  `;
  return {
    subject: "[Rioko 2.0] Validação VIES manual necessária",
    html: shell({
      title: "Validação VIES manual necessária",
      bodyHtml: body,
      ...baseInput(input),
    }),
  };
}

export function tplNifInvalid(input: IncidentTemplateInput): RenderedTemplate {
  const body = `
    ${paragraph(escapeHtml(input.summary))}
    ${calloutBox("Causa provável", "O NIF não passou na validação algorítmica portuguesa ou não existe no registo da AT.", BRAND.warning)}
    ${stepsList([
      "Confirme o NIF junto do cliente.",
      "Se o cliente for estrangeiro, considere desactivar a retenção/IVA para essa encomenda em Dev Mode.",
      "Reemita a factura após corrigir os dados do cliente.",
    ])}
    ${affectedIdsBlock(input.affectedIds)}
  `;
  return {
    subject: "[Rioko 2.0] NIF inválido em factura",
    html: shell({
      title: "NIF inválido em factura",
      bodyHtml: body,
      ...baseInput(input),
    }),
  };
}

export function tplSubscriptionInactive(input: IncidentTemplateInput): RenderedTemplate {
  const body = `
    ${paragraph("A subscrição Kapta associada à sua conta está inactiva. <strong>O Rioko 2.0 está a pausar a emissão de facturas</strong> até a situação ser regularizada.", { strong: true })}
    ${calloutBox("Acção necessária", "Pagamentos continuam a chegar mas não estão a ser facturados.", BRAND.critical)}
    ${stepsList([
      "Verifique o estado da sua subscrição em Faturação no painel.",
      "Actualize o método de pagamento se necessário.",
      "Após regularizar, as encomendas pendentes podem ser reemitidas em Dev Mode.",
    ])}
    ${affectedIdsBlock(input.affectedIds)}
    ${ctaButton("Ver subscrição", `${input.dashboardUrl ?? DEFAULT_DASHBOARD}/faturacao`)}
  `;
  return {
    subject: "[Rioko 2.0] Subscrição inactiva — emissão pausada",
    html: shell({
      title: "Subscrição inactiva — emissão pausada",
      preheader: "Pagamentos não estão a ser facturados. Regularize a subscrição.",
      bodyHtml: body,
      ...baseInput(input),
    }),
  };
}

export function tplQueueRetryExhausted(input: IncidentTemplateInput): RenderedTemplate {
  const body = `
    ${paragraph("Um webhook foi tentado várias vezes e continua a falhar. O Rioko 2.0 parou de tentar automaticamente.")}
    ${calloutBox("Causa provável", "Erro persistente do lado do sistema de destino ou dados da encomenda inconsistentes.", BRAND.error)}
    ${stepsList([
      "Verifique o detalhe técnico abaixo.",
      "Após corrigir, reexecute manualmente em Dev Mode.",
    ])}
    ${affectedIdsBlock(input.affectedIds)}
    ${detailBlock(input.detail)}
    ${ctaButton("Abrir Dev Mode", `${input.dashboardUrl ?? DEFAULT_DASHBOARD}/superadmin`)}
  `;
  return {
    subject: "[Rioko 2.0] Tentativas esgotadas em webhook",
    html: shell({
      title: "Tentativas esgotadas em webhook",
      bodyHtml: body,
      ...baseInput(input),
    }),
  };
}

export function tplWebhookInvalidSignature(input: IncidentTemplateInput): RenderedTemplate {
  const body = `
    ${paragraph("Um webhook chegou com assinatura inválida e foi rejeitado.")}
    ${calloutBox("Causa provável", "O segredo de assinatura no Rioko 2.0 não coincide com o configurado em Shopify/Stripe. Isto bloqueia <strong>todas</strong> as facturas até ser corrigido.", BRAND.critical)}
    ${stepsList([
      "Copie o webhook signing secret da consola de Shopify ou Stripe.",
      "No Rioko 2.0, cole-o em Integrações → reconectar.",
      "Reexecute manualmente as encomendas afetadas em Dev Mode.",
    ])}
    ${affectedIdsBlock(input.affectedIds)}
    ${ctaButton("Abrir Integrações", `${input.dashboardUrl ?? DEFAULT_DASHBOARD}/integrations`)}
  `;
  return {
    subject: "[Rioko 2.0] Assinatura de webhook inválida",
    html: shell({
      title: "Assinatura de webhook inválida",
      preheader: "Webhooks rejeitados — segredo desactualizado.",
      bodyHtml: body,
      ...baseInput(input),
    }),
  };
}

export function renderIncidentTemplate(kind: IncidentKind, input: IncidentTemplateInput): RenderedTemplate {
  switch (kind) {
    case "auth_failure_destination": return tplAuthFailureDestination(input);
    case "auth_failure_source": return tplAuthFailureSource(input);
    case "destination_reject": return tplDestinationReject(input);
    case "normalize_fail": return tplNormalizeFail(input);
    case "nif_invalid": return tplNifInvalid(input);
    case "subscription_inactive": return tplSubscriptionInactive(input);
    case "queue_retry_exhausted": return tplQueueRetryExhausted(input);
    case "webhook_invalid_signature": return tplWebhookInvalidSignature(input);
    case "vies_unconfirmed": return tplViesUnconfirmed(input);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Daily digest
// ──────────────────────────────────────────────────────────────────────────

export interface DigestIncident {
  kind: IncidentKind;
  summary: string;
  occurrences: number;
  lastSeenAt: string;
  severity?: Severity;
  connectionLabel?: string;
}

export function tplDigest(input: {
  merchantName?: string;
  incidents: DigestIncident[];
  helpUrl?: string;
  dashboardUrl?: string;
}): RenderedTemplate {
  const helpUrl = input.helpUrl ?? DEFAULT_HELP_URL;
  const dashboardUrl = input.dashboardUrl ?? DEFAULT_DASHBOARD;
  const merchant = input.merchantName ? `<p style="margin:6px 0 0;color:#94a3b8;font-size:13px">${escapeHtml(input.merchantName)}</p>` : "";

  const rows = input.incidents.map(i => {
    const sevColor = severityColor(i.severity);
    return `<tr>
      <td style="padding:14px 0;border-bottom:1px solid ${BRAND.border};vertical-align:top;width:8px">
        <div style="width:6px;height:36px;background:${sevColor};border-radius:3px"></div>
      </td>
      <td style="padding:14px 12px;border-bottom:1px solid ${BRAND.border};vertical-align:top">
        <div style="font-size:11px;font-weight:600;color:${BRAND.muted};letter-spacing:0.3px;text-transform:uppercase;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(i.kind)}</div>
        <div style="font-size:14px;color:${BRAND.text};margin-top:3px;line-height:1.45">${escapeHtml(i.summary)}</div>
      </td>
      <td style="padding:14px 0;border-bottom:1px solid ${BRAND.border};vertical-align:top;text-align:right;font-size:13px;color:${BRAND.muted};white-space:nowrap">
        ${i.occurrences}×
      </td>
    </tr>`;
  }).join("");

  const html = `<!doctype html>
<html lang="pt-PT">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark only">
  <meta name="supported-color-schemes" content="dark only">
</head>
<body style="margin:0;padding:0;background:${BRAND.pageBg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:${BRAND.text}">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${input.incidents.length} incidente(s) em aberto necessitam de atenção.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.pageBg};padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;width:100%;background:${BRAND.cardBg};border-radius:14px;overflow:hidden">
        <tr><td class="header-bg" bgcolor="#1e1b4b" style="background-color:#1e1b4b;background-image:${BRAND.bgGradient};padding:28px 32px 24px">
          <img src="${LOGO_WHITE}" alt="Rioko 2.0" width="140" height="auto" style="display:block;border:0;max-width:140px;height:auto">
          <h1 class="force-white" style="margin:20px 0 0;color:#ffffff !important;font-size:22px;font-weight:600;letter-spacing:-0.3px"><font color="#ffffff">Resumo diário de incidentes</font></h1>
          ${merchant}
          <div style="height:3px;width:100%;background-color:${BRAND.blue};background-image:linear-gradient(90deg, ${BRAND.blue}, ${BRAND.purple});margin-top:24px"></div>
        </td></tr>
        <tr><td class="card-bg" bgcolor="${BRAND.cardBg}" style="background-color:${BRAND.cardBg};padding:28px 32px;color:${BRAND.text}">
          <p style="margin:0 0 20px;color:${BRAND.muted};font-size:14px">
            <font color="${BRAND.text}"><strong>${input.incidents.length}</strong></font> <font color="${BRAND.muted}">incidente${input.incidents.length === 1 ? "" : "s"} em aberto ${input.incidents.length === 1 ? "necessita" : "necessitam"} de atenção.</font>
          </p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tbody>${rows}</tbody>
          </table>
          <div style="margin-top:24px">
            ${ctaButton("Ver no painel", `${dashboardUrl}/superadmin/incidents`)}
          </div>
        </td></tr>
        <tr><td class="footer-bg" bgcolor="${BRAND.cardBgAlt}" style="background-color:${BRAND.cardBgAlt};padding:24px 32px;border-top:1px solid ${BRAND.border};text-align:center">
          <p class="force-muted" style="margin:0;font-size:13px;color:${BRAND.muted};line-height:1.6">
            <font color="${BRAND.muted}">Precisa de ajuda?</font> <a href="${escapeHtml(helpUrl)}" class="force-blue" style="color:${BRAND.blue};text-decoration:none;font-weight:500"><font color="${BRAND.blue}">Contacte a equipa Rioko 2.0</font></a>
          </p>
          <p class="force-muted" style="margin:12px 0 0;font-size:11px;color:${BRAND.muted}">
            <font color="${BRAND.muted}">Rioko 2.0 by <a href="https://kapta.pt" style="color:${BRAND.muted};text-decoration:underline"><font color="${BRAND.muted}">Kapta</font></a> · Notificação automática</font>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return {
    subject: `[Rioko 2.0] Resumo diário — ${input.incidents.length} incidente(s) em aberto`,
    html,
  };
}
