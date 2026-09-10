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
  // We created the document and the destination stored something else — a total,
  // a reference or an exemption code that differs from the payload we sent.
  // OPS-ONLY on purpose: deliberately absent from MERCHANT_ACTIONABLE_KINDS,
  // because the merchant cannot act on the gap between our request and the
  // destination's storage, and the document is usually otherwise fine.
  | "document_drift"
  | "auth_failure_destination"
  | "auth_failure_source"
  | "destination_reject"
  | "normalize_fail"
  | "nif_invalid"
  // The document WAS issued, but as a draft, because the buyer typed something
  // into the address line that was meant to be a NIF and does not validate.
  // Distinct from `nif_invalid` (nothing was issued at all) because the action
  // the merchant has to take is different: correct and re-emit a draft that
  // already exists, rather than chase an order with no document.
  | "nif_invalid_draft"
  // A refund arrived for an order whose document is still a draft. A credit
  // note only exists to correct a finalized document, so the remedy is to edit
  // or delete the draft — a decision only the merchant can make.
  | "credit_note_on_draft"
  // A booking was cancelled after we had already issued a FINALIZED document
  // for it. Drafts are deleted automatically; a closed document is AT-hashed and
  // only a credit note undoes it, which is the merchant's call to make.
  | "booking_cancelled_after_invoice"
  // Stays that already ended with no payment recorded in Lodgify. Invoicing is
  // triggered by the merchant marking a booking paid, so a forgotten one is
  // never billed at all — this is what keeps that from being silent.
  | "lodgify_payment_not_marked"
  | "subscription_inactive"
  | "queue_retry_exhausted"
  | "webhook_invalid_signature"
  | "vies_unconfirmed"
  | "reconcile_drift"
  | "currency_not_supported"
  // A tag rule asked for a simplified invoice but the sale did not qualify
  // (over the art. 40.º CIVA cap, or the buyer gave a NIF). The document WAS
  // issued, as a full invoice — this tells the merchant their rule silently
  // did not apply, so they can narrow the tag or accept the downgrade.
  | "simplified_invoice_downgraded"
  // Our own fixed-IP egress relay is not answering, so no Lodgify call can be
  // made at all. OPS-ONLY, deliberately absent from MERCHANT_ACTIONABLE_KINDS:
  // the merchant can do nothing about our infrastructure, and the remedy is
  // ours. Distinct from `auth_failure_source` (their credentials) and from a
  // Lodgify IP block (their decision) because the action differs completely.
  | "lodgify_relay_down";

export type Severity = "info" | "warning" | "error" | "critical";

export interface IncidentTemplateInput {
  merchantName?: string;
  connectionLabel?: string;            // e.g. "Stripe → InvoiceXpress"
  /** Human order reference, e.g. "#1234" (shown above the technical id). */
  orderRef?: string;
  /** End-customer name on the would-be document, e.g. "João Silva". */
  clientName?: string;
  /** Optional AI-generated advisory diagnosis (European Portuguese). */
  aiDiagnosis?: string;
  /** Optional AI-generated advisory fix to accompany the diagnosis. */
  aiSuggestedFix?: string;
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
// Type. Night has always used the system stack; day brings the dashboard's
// faces, for the clients that honour @font-face. Single quotes throughout:
// these land inside double-quoted style attributes.
/**
 * The dashboard's two faces, for the clients that honour @font-face (Apple Mail,
 * iOS Mail, Thunderbird). Everywhere else falls through to the system stack and
 * the layout is unchanged, because the metrics are close enough not to reflow.
 */
const FONT_FACES = `
    @font-face { font-family: "General Sans"; src: url("https://rioko.online/fonts/GeneralSans-Regular.woff2") format("woff2"); font-weight: 400; font-display: swap; }
    @font-face { font-family: "General Sans"; src: url("https://rioko.online/fonts/GeneralSans-Medium.woff2") format("woff2"); font-weight: 500; font-display: swap; }
    @font-face { font-family: "General Sans"; src: url("https://rioko.online/fonts/GeneralSans-Semibold.woff2") format("woff2"); font-weight: 600; font-display: swap; }
    @font-face { font-family: "Satoshi"; src: url("https://rioko.online/fonts/Satoshi-Medium.woff2") format("woff2"); font-weight: 500; font-display: swap; }`;

const SYSTEM_STACK = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif`;
const DAY_BODY = `'General Sans',${SYSTEM_STACK}`;
const DAY_DISPLAY = `'Satoshi','General Sans',${SYSTEM_STACK}`;

export type EmailTheme = "day" | "night";

interface Palette {
  pageBg: string;        // outside the card
  cardBg: string;        // card body
  cardBgAlt: string;     // footer / meta zone
  headerBg: string;      // header bar, also the bgcolor fallback
  bgGradient: string;
  text: string;          // primary text
  textStrong: string;    // headings on the header bar
  muted: string;
  border: string;
  borderSubtle: string;
  chipBg: string;
  blue: string;          // links + the primary accent
  purple: string;        // the second half of the accent stripe
  ctaBg: string;
  ctaText: string;
  /** The wordmark, in the version that reads on `headerBg`. */
  logoUrl: string;
  logoWidth: number;
  /** Header bar. `headerGradient: "none"` leaves it flat. */
  headerGradient: string;
  headerRule: string;
  /** The chip that names the connection, sitting on the header bar. */
  headerChipBg: string;
  headerChipBorder: string;
  headerChipText: string;
  /** The "3x ocorrências" chip. */
  occurBg: string;
  occurText: string;
  /** Callout plates. Night draws a rule down the left; day is a plain plate. */
  calloutBg: string;
  calloutRule: string;
  /** Card corner. The dashboard's cards are 20px by day. */
  radius: string;
  fontBody: string;
  fontDisplay: string;
  /** Shapes. Night keeps what it shipped; day follows the dashboard. */
  titleType: string;
  eyebrowType: string;
  chipRadius: string;
  ctaShape: string;
  platePad: string;
  plateRadius: string;
  idChip: string;
  idChipBorder: string;
  stripe: string;
  /** The rule under the title: night runs the brand gradient, day takes the
   *  severity colour flat. */
  stripeAccent: boolean;
  chipType: string;
  sectionType: string;
  occurBorder: string;
  /** The mono chip naming the connection. */
  monoChipRadius: string;
  /** @font-face block. Only day loads the dashboard's faces. */
  faces: string;
  codeBg: string;
  codeText: string;
  info: string;
  warning: string;
  error: string;
  critical: string;
  colorScheme: string;   // <meta name="color-scheme">
}

// Night: the palette these emails have always used. Dark-first, and shaped to
// sidestep Gmail mobile dark-mode auto-inversion (which turns white->gray while
// leaving dark text dark — invisible on the resulting mid-gray card).
const NIGHT: Palette = {
  pageBg: "#0a0f1c",
  cardBg: "#0f172a",
  cardBgAlt: "#111a2e",
  headerBg: "#1e1b4b",
  bgGradient: "linear-gradient(135deg, #1e293b 0%, #0f172a 50%, #1e1b4b 100%)",
  text: "#f1f5f9",
  textStrong: "#fefefe",
  muted: "#94a3b8",
  border: "#1e2a44",
  borderSubtle: "#334155",
  chipBg: "#1e293b",
  blue: "#38bdf8",
  purple: "#a855f7",
  ctaBg: "#38bdf8",
  ctaText: "#0a0f1c",
  codeBg: "#070d1a",
  codeText: "#cbd5e1",
  info: "#38bdf8",
  warning: "#fbbf24",
  error: "#f87171",
  critical: "#ef4444",
  colorScheme: "dark only",
  logoUrl: "https://rioko.online/images/rioko2-logo.png",
  logoWidth: 140,
  headerGradient: "linear-gradient(135deg, #1e293b 0%, #0f172a 50%, #1e1b4b 100%)",
  headerRule: "none",
  headerChipBg: "rgba(255,255,255,0.08)",
  headerChipBorder: "rgba(255,255,255,0.15)",
  headerChipText: "#cbd5e1",
  occurBg: "rgba(251,191,36,0.18)",
  occurText: "#fbbf24",
  calloutBg: "#1e293b",
  calloutRule: "3px",
  radius: "14px",
  fontBody: SYSTEM_STACK,
  fontDisplay: SYSTEM_STACK,
  titleType: "font-size:22px;font-weight:600;letter-spacing:-0.3px;line-height:1.3",
  eyebrowType: "font-size:12px;font-weight:600;letter-spacing:0.4px",
  chipRadius: "12px",
  ctaShape: "border-radius:8px|padding:10px 22px;font-weight:600",
  platePad: "14px 18px",
  plateRadius: "6px",
  idChip: "border-radius:5px|padding:4px 8px;margin:0 4px 4px 0",
  idChipBorder: "#334155",
  stripe: "3px",
  stripeAccent: false,
  chipType: "font-weight:600;letter-spacing:0.5px",
  occurBorder: "rgba(251,191,36,0.35)",
  monoChipRadius: "6px",
  sectionType: "font-size:14px;font-weight:600;letter-spacing:0.3px",
  faces: "",
};

// Day: the Kapta-admin skin the dashboard wears in Day Mode. Cream page, white
// card, ink header carrying the white wordmark, terracotta as the accent. The
// status inks are the dark end of each ramp, the same choice the dashboard
// makes, so they stay readable on a light card.
const DAY: Palette = {
  pageBg: "#F6F3EE",
  cardBg: "#FFFFFF",
  cardBgAlt: "#FAF7F1",
  headerBg: "#FFFFFF",
  bgGradient: "linear-gradient(135deg, #2A2A2A 0%, #111111 55%, #3A1F17 100%)",
  text: "#111111",
  textStrong: "#111111",
  muted: "#8A857E",
  border: "#E7DED3",
  borderSubtle: "#CABFB2",
  chipBg: "#F6F3EE",
  blue: "#9F3F2E",
  purple: "#C75C4A",
  ctaBg: "#111111",
  ctaText: "#FFFFFF",
  codeBg: "#F6F3EE",
  codeText: "#4B4B4B",
  info: "#0369A1",
  warning: "#92400E",
  error: "#B42318",
  critical: "#B42318",
  colorScheme: "light only",
  logoUrl: "https://rioko.online/images/logo-rioko-black.png",
  logoWidth: 108,
  headerGradient: "none",
  headerRule: "#E7DED3",
  headerChipBg: "#F6F3EE",
  headerChipBorder: "#E7DED3",
  headerChipText: "#4B4B4B",
  occurBg: "#F6F3EE",
  occurText: "#4B4B4B",
  calloutBg: "#F6F3EE",
  calloutRule: "0",
  radius: "20px",
  fontBody: DAY_BODY,
  fontDisplay: DAY_DISPLAY,
  titleType: "font-size:24px;font-weight:500;letter-spacing:-0.02em;line-height:1.25",
  eyebrowType: "font-size:11px;font-weight:700;letter-spacing:0.06em",
  chipRadius: "999px",
  ctaShape: "border-radius:999px|padding:13px 26px;font-weight:500",
  platePad: "16px 20px",
  plateRadius: "12px",
  idChip: "border-radius:999px|padding:4px 10px;margin:0 4px 6px 0",
  idChipBorder: "#CABFB2",
  stripe: "2px",
  stripeAccent: true,
  chipType: "font-weight:700;letter-spacing:0.06em",
  occurBorder: "#E7DED3",
  monoChipRadius: "999px",
  sectionType: "font-size:11px;font-weight:700;letter-spacing:0.06em",
  faces: FONT_FACES,
};

// Which palette the next template renders in.
//
// Rendering is pure string building with no `await` anywhere in it, so a value
// parked here cannot be observed by another request: JavaScript only interleaves
// at suspension points, and there are none between `renderInTheme` setting this
// and the render returning. `renderInTheme` is the only supported way to change
// it, and it always restores what it found.
let CURRENT: Palette = NIGHT;

function P(): Palette {
  return CURRENT;
}

/** Render a template in a given skin. Synchronous by contract — see CURRENT. */
export function renderInTheme<T>(theme: EmailTheme | undefined, render: () => T): T {
  const previous = CURRENT;
  CURRENT = theme === "day" ? DAY : NIGHT;
  try {
    return render();
  } finally {
    CURRENT = previous;
  }
}

// Wide PNG logo hosted on rioko.online (Gmail's image proxy reliably fetches
// from there; workers.dev subdomains are unreliable, inline base64 ≥ ~10KB
// gets stripped on Gmail web, and SVG data URIs are stripped entirely).
/** Kept for callers that hardcoded it; the skins choose through `P().logoUrl`. */
const LOGO_WHITE = "https://rioko.online/images/rioko2-logo.png";

/** rioko.online/pt. The legal pages every email links to, small, in the footer. */
const LEGAL = {
  privacy: "https://rioko.online/pt/privacy",
  terms: "https://rioko.online/pt/terms",
};

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
  // No severity is not an "info" alert: it is an ordinary message, and it takes
  // the brand accent.
  if (!s) return P().blue;
  return s === "critical" ? P().critical
    : s === "error" ? P().error
    : s === "warning" ? P().warning
    : P().info;
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
  /** Incident meta. Absent for emails that are not about a recurring problem
   *  (an account invite, say) — the meta row is then not rendered at all. */
  firstSeenAt?: string;
  lastSeenAt?: string;
  occurrences?: number;
  /** Footer note. Defaults to the automatic-notification wording. */
  footerNote?: string;
}): string {
  const accent = severityColor(opts.severity);
  const severityChip = opts.severity ? `
    <span style="display:inline-block;background:${accent};color:#fff;font-size:11px;${P().chipType};text-transform:uppercase;padding:4px 10px;border-radius:${P().chipRadius};vertical-align:middle">
      ${severityLabelPT(opts.severity)}
    </span>` : "";

  const occurChip = (opts.occurrences ?? 0) > 1 ? `
    <span style="display:inline-block;background:${P().occurBg};color:${P().occurText};border:1px solid ${P().occurBorder};font-size:11px;font-weight:600;padding:3px 9px;border-radius:${P().chipRadius};margin-left:6px;vertical-align:middle">
      ${opts.occurrences}× ocorrências
    </span>` : "";

  const connectionChip = opts.connectionLabel ? `
    <div style="margin-top:8px">
      <span style="display:inline-block;background:${P().headerChipBg};border:1px solid ${P().headerChipBorder};color:${P().headerChipText};font-size:12px;font-weight:500;padding:4px 10px;border-radius:${P().monoChipRadius};font-family:ui-monospace,SFMono-Regular,Menlo,monospace">
        ${escapeHtml(opts.connectionLabel)}
      </span>
    </div>` : "";

  const merchantLine = opts.merchantName ? `
    <p style="margin:6px 0 0;color:${P().muted};font-size:13px">
      ${escapeHtml(opts.merchantName)}
    </p>` : "";

  return `<!doctype html>
<html lang="pt-PT">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="${P().colorScheme}">
  <meta name="supported-color-schemes" content="${P().colorScheme}">
  <title>${escapeHtml(opts.title)}</title>
  <style>${P().faces}
    /* Gmail mobile (Android + iOS) injects data-ogsc on body / data-ogsb on bg-styled elements
       when dark mode is on, then rewrites colors. Targeting those attributes lets us force
       the colors we want and survive Gmail's rewrite. */
    /* Gmail mobile dark-mode auto-inverts pure #ffffff text on dark bg (breaks our
       intentionally dark header). Near-white #fefefe escapes the heuristic — Gmail's
       color rewriter only targets exact pure white/black. */
    [data-ogsc] .force-white, [data-ogsc] .force-white * { color: ${P().textStrong} !important; }
    [data-ogsc] .force-muted, [data-ogsc] .force-muted * { color: ${P().muted} !important; }
    [data-ogsc] .force-blue { color: ${P().blue} !important; }
    [data-ogsb] .header-bg { background-color: ${P().headerBg} !important; background-image: ${P().bgGradient} !important; }
    [data-ogsb] .card-bg { background-color: ${P().cardBg} !important; }
    [data-ogsb] .footer-bg { background-color: ${P().cardBgAlt} !important; }

    /* Apple Mail + iOS Mail + clients honoring prefers-color-scheme */
    @media (prefers-color-scheme: dark) {
      .force-white, .force-white * { color: ${P().textStrong} !important; }
      .force-muted, .force-muted * { color: ${P().muted} !important; }
      .header-bg { background-color: ${P().headerBg} !important; }
      .card-bg { background-color: ${P().cardBg} !important; }
      .footer-bg { background-color: ${P().cardBgAlt} !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:${P().pageBg};font-family:${P().fontBody};color:${P().text};-webkit-font-smoothing:antialiased">
  <!-- preheader (hidden, shows in inbox preview) -->
  ${opts.preheader ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escapeHtml(opts.preheader)}</div>` : ""}

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${P().pageBg}" style="background-color:${P().pageBg};padding:32px 16px">
    <tr>
      <td align="center" bgcolor="${P().pageBg}">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="${P().cardBg}" style="max-width:600px;width:100%;background-color:${P().cardBg};border-radius:${P().radius};overflow:hidden;border:1px solid ${P().headerRule === "none" ? "transparent" : P().headerRule}">
          <!-- header bar — bgcolor + classed for Gmail mobile dark-mode override -->
          <tr>
            <td class="header-bg" bgcolor="${P().headerBg}" style="background-color:${P().headerBg};${P().headerGradient === "none" ? "" : `background-image:${P().headerGradient};`}padding:28px 32px 24px;${P().headerRule === "none" ? "" : `border-bottom:1px solid ${P().headerRule};`}position:relative">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td valign="middle">
                    <img src="${P().logoUrl}" alt="Rioko 2.0" width="${P().logoWidth}" height="auto" style="display:block;border:0;outline:none;text-decoration:none;max-width:${P().logoWidth}px;height:auto">
                  </td>
                  <td valign="middle" align="right">
                    ${severityChip}${occurChip}
                  </td>
                </tr>
              </table>
              <div class="force-white" style="margin-top:20px">
                <h1 class="force-white" style="margin:0;color:${P().textStrong};font-family:${P().fontDisplay};${P().titleType};mso-line-height-rule:exactly">
                  <span style="color:${P().textStrong}">${escapeHtml(opts.title)}</span>
                </h1>
                ${merchantLine}
                ${connectionChip}
              </div>
              <!-- severity accent stripe -->
              <div style="height:${P().stripe};width:100%;background-color:${P().stripeAccent ? accent : P().blue};${P().headerGradient === "none" ? "" : `background-image:linear-gradient(90deg, ${P().blue}, ${P().purple});`}margin-top:24px"></div>
            </td>
          </tr>

          <!-- body card -->
          <tr>
            <td class="card-bg" bgcolor="${P().cardBg}" style="background-color:${P().cardBg};padding:32px;color:${P().text}">
              ${opts.bodyHtml}
            </td>
          </tr>

          <!-- meta row (incidents only) -->
          ${opts.firstSeenAt && opts.lastSeenAt ? `
          <tr>
            <td class="card-bg" bgcolor="${P().cardBg}" style="background-color:${P().cardBg};padding:0 32px 24px">
              <hr style="border:none;border-top:1px solid ${P().border};margin:0 0 16px">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:12px;color:${P().muted}">
                <tr>
                  <td style="color:${P().muted}"><font color="${P().muted}">Primeira ocorrência</font></td>
                  <td align="right" style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:${P().muted}"><font color="${P().muted}">${escapeHtml(opts.firstSeenAt)}</font></td>
                </tr>
                <tr>
                  <td style="padding-top:4px;color:${P().muted}"><font color="${P().muted}">Última ocorrência</font></td>
                  <td align="right" style="padding-top:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:${P().muted}"><font color="${P().muted}">${escapeHtml(opts.lastSeenAt)}</font></td>
                </tr>
              </table>
            </td>
          </tr>` : ""}

          <!-- footer -->
          <tr>
            <td class="footer-bg" bgcolor="${P().cardBgAlt}" style="background-color:${P().cardBgAlt};padding:24px 32px;border-top:1px solid ${P().border};text-align:center">
              <p class="force-muted" style="margin:0;font-size:13px;color:${P().muted};line-height:1.6">
                <font color="${P().muted}">Precisa de ajuda?</font>
                <a href="${escapeHtml(opts.helpUrl)}" class="force-blue" style="color:${P().blue};text-decoration:none;font-weight:500"><font color="${P().blue}">Contacte a equipa Rioko 2.0</font></a>
                <font color="${P().muted}">·</font>
                <a href="${escapeHtml(opts.dashboardUrl)}" class="force-blue" style="color:${P().blue};text-decoration:none;font-weight:500"><font color="${P().blue}">Abrir painel</font></a>
              </p>
              <p class="force-muted" style="margin:12px 0 0;font-size:11px;color:${P().muted}">
                <font color="${P().muted}">Rioko 2.0 by <a href="https://kapta.pt" style="color:${P().muted};text-decoration:underline"><font color="${P().muted}">Kapta</font></a> · ${escapeHtml(opts.footerNote ?? "Notificação automática · Não responda a este email")}</font>
              </p>
              ${legalLinks()}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Small print, every email: where the terms and the privacy policy live. */
function legalLinks(): string {
  return `
              <p class="force-muted" style="margin:10px 0 0;font-size:11px;color:${P().muted}">
                <a href="${LEGAL.privacy}" style="color:${P().muted};text-decoration:underline"><font color="${P().muted}">Política de privacidade</font></a>
                <font color="${P().muted}"> · </font>
                <a href="${LEGAL.terms}" style="color:${P().muted};text-decoration:underline"><font color="${P().muted}">Termos e condições</font></a>
              </p>`;
}

function sectionTitle(text: string): string {
  return `<h2 style="margin:0 0 12px;${P().sectionType};text-transform:uppercase;color:${P().muted}">${escapeHtml(text)}</h2>`;
}

function paragraph(text: string, opts: { strong?: boolean } = {}): string {
  return `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${P().text}${opts.strong ? ";font-weight:500" : ""}">${text}</p>`;
}

function calloutBox(headingText: string, html: string, accent = P().blue): string {
  // A plate, the way the dashboard states one: tinted ground, an eyebrow in the
  // status colour, and no rule down the side.
  const rule = P().calloutRule === "0" ? "" : `border-left:${P().calloutRule} solid ${accent};`;
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${P().calloutBg};${rule}border-radius:${P().plateRadius};margin:0 0 ${P().plateRadius === "6px" ? "20px" : "24px"}">
    <tr>
      <td style="padding:${P().platePad}">
        <p style="margin:0 0 6px;${P().eyebrowType};text-transform:uppercase;color:${accent}">${escapeHtml(headingText)}</p>
        <div style="font-size:14px;line-height:1.6;color:${P().text}">${html}</div>
      </td>
    </tr>
  </table>`;
}

// Advisory order-specific diagnosis. Rendered in a distinct purple callout (vs the
// blue/red static "Causa provável"). Per request, the email carries NO reference to
// how it was generated — just a soft "indicativo" disclaimer. Renders nothing when
// no diagnosis is present (fail-open path).
function aiDiagnosisBlock(diagnosis?: string, fix?: string): string {
  if (!diagnosis) return "";
  const body =
    `${escapeHtml(diagnosis)}` +
    (fix ? `<div style="margin-top:8px"><strong>Correção sugerida:</strong> ${escapeHtml(fix)}</div>` : "") +
    `<div style="margin-top:10px;font-size:11px;color:${P().muted}">Indicativo · não substitui verificação humana</div>`;
  return calloutBox("Diagnóstico", body, P().purple);
}

function stepsList(steps: string[]): string {
  return `
  ${sectionTitle("O que tentar primeiro")}
  <ol style="margin:0 0 24px;padding-left:20px;font-size:14px;color:${P().text};line-height:1.7">
    ${steps.map(s => `<li style="margin-bottom:6px">${escapeHtml(s)}</li>`).join("")}
  </ol>`;
}

// Order + client identity block. Renders a labeled 2-row table so the alert
// names WHICH order and WHICH client it refers to, instead of leaving the
// reader to dig the numeric id out of the technical detail. Omits any row whose
// value is missing; renders nothing at all when both are absent.
function orderClientBlock(orderRef?: string, clientName?: string): string {
  const rows: string[] = [];
  const row = (label: string, value: string) => `
    <tr>
      <td style="padding:4px 0;font-size:13px;color:${P().muted};width:90px;vertical-align:top"><font color="${P().muted}">${escapeHtml(label)}</font></td>
      <td style="padding:4px 0;font-size:14px;color:${P().text};font-weight:500"><font color="${P().text}">${escapeHtml(value)}</font></td>
    </tr>`;
  if (orderRef) rows.push(row("Encomenda", orderRef));
  if (clientName) rows.push(row("Cliente", clientName));
  if (rows.length === 0) return "";
  return `
  ${sectionTitle("Encomenda")}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px">${rows.join("")}</table>`;
}

function affectedIdsBlock(ids?: string[]): string {
  if (!ids || ids.length === 0) return "";
  const shown = ids.slice(0, 10);
  const more = ids.length > 10 ? `<div style="font-size:12px;color:${P().muted};margin-top:8px">… e mais ${ids.length - 10}</div>` : "";
  const chips = shown.map(id =>
    `<span style="display:inline-block;background:${P().calloutBg};border:1px solid ${P().idChipBorder};color:${P().text};font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;${P().idChip.split("|")[0]};${P().idChip.split("|")[1]}">${escapeHtml(id)}</span>`
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
  <pre style="margin:0 0 24px;padding:14px;background:${P().codeBg};color:${P().codeText};border:1px solid ${P().border};border-radius:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.55;overflow-x:auto;white-space:pre-wrap;word-break:break-word">${escapeHtml(json)}</pre>`;
}

function ctaButton(label: string, href: string): string {
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 0">
    <tr>
      <td style="background:${P().ctaBg};${P().ctaShape.split("|")[0]}">
        <a href="${escapeHtml(href)}" style="display:inline-block;${P().ctaShape.split("|")[1]};color:${P().ctaText};font-size:14px;text-decoration:none;font-family:inherit">${escapeHtml(label)}</a>
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
    ${calloutBox("Causa provável", "A chave de API expirou, foi rodada ou o utilizador foi removido.", P().error)}
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
    ${calloutBox("Causa provável", "Token revogado, sessão expirada ou conta suspensa.", P().error)}
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
    ${calloutBox("Causa provável", "Dados inválidos: NIF incorreto, código de imposto inexistente, sequência sem permissões, ou cliente em estado inconsistente.", P().error)}
    ${aiDiagnosisBlock(input.aiDiagnosis, input.aiSuggestedFix)}
    ${stepsList([
      "Abra o documento no sistema de faturação e veja a mensagem de erro detalhada.",
      "Corrija os dados do cliente ou do produto, conforme aplicável.",
      "Reexecute a encomenda em Dev Mode após a correcção.",
    ])}
    ${orderClientBlock(input.orderRef, input.clientName)}
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
    ${calloutBox("Causa provável", "O serviço de normalização devolveu um erro transitório ou a encomenda tem um formato inesperado.", P().warning)}
    ${stepsList([
      "Aguarde alguns minutos e reexecute em Dev Mode.",
      "Se persistir, contacte o suporte com o ID da encomenda.",
    ])}
    ${orderClientBlock(input.orderRef, input.clientName)}
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
    ${calloutBox("Acção necessária", "Validar o NIF/VAT do cliente manualmente em <a href=\"https://viesvalidation.com/pt/\" target=\"_blank\" style=\"color:${P().blue}\">viesvalidation.com/pt</a> e aprovar ou rejeitar no dashboard.", P().warning)}
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
    ${calloutBox("Causa provável", "O NIF não passou na validação algorítmica portuguesa ou não existe no registo da AT.", P().warning)}
    ${aiDiagnosisBlock(input.aiDiagnosis, input.aiSuggestedFix)}
    ${stepsList([
      "Confirme o NIF junto do cliente.",
      "Se o cliente for estrangeiro, considere desactivar a retenção/IVA para essa encomenda em Dev Mode.",
      "Reemita a factura após corrigir os dados do cliente.",
    ])}
    ${orderClientBlock(input.orderRef, input.clientName)}
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

export function tplNifInvalidDraft(input: IncidentTemplateInput): RenderedTemplate {
  const d = (input.detail ?? {}) as Record<string, any>;
  const found = d.raw ? `<strong>${escapeHtml(String(d.raw))}</strong>` : "um valor";
  const where = d.field ? ` (${escapeHtml(String(d.field))})` : "";
  const body = `
    ${paragraph(escapeHtml(input.summary))}
    ${calloutBox(
    "Porquê rascunho",
    `A morada trazia ${found} na segunda linha${where}. Parece um contribuinte, mas não passa na validação portuguesa. `
    + `A factura foi emitida <strong>sem esse número e em rascunho</strong> — nada foi comunicado à AT e nada foi enviado ao cliente.`,
    P().warning,
  )}
    ${aiDiagnosisBlock(input.aiDiagnosis, input.aiSuggestedFix)}
    ${stepsList([
    "Confirme o NIF junto do cliente.",
    "Corrija a morada da encomenda no Shopify — ou apague o valor, se afinal não era um NIF.",
    "Reemita a factura a partir do painel: o rascunho é substituído e finaliza normalmente.",
    "Se o cliente não quer NIF, finalize o rascunho como está (Consumidor Final).",
  ])}
    ${orderClientBlock(input.orderRef, input.clientName)}
    ${d.permalink ? ctaButton("Abrir rascunho na InvoiceXpress", String(d.permalink)) : ""}
    ${affectedIdsBlock(input.affectedIds)}
  `;
  return {
    subject: "[Rioko 2.0] Factura em rascunho — NIF inválido na morada",
    html: shell({
      title: "Factura ficou em rascunho",
      bodyHtml: body,
      ...baseInput(input),
    }),
  };
}

export function tplCreditNoteOnDraft(input: IncidentTemplateInput): RenderedTemplate {
  const d = (input.detail ?? {}) as Record<string, any>;
  const body = `
    ${paragraph(escapeHtml(input.summary))}
    ${calloutBox(
    "Porque não foi emitida",
    "Uma nota de crédito só corrige um documento já finalizado. Sobre um rascunho não há nada a corrigir — "
    + "basta editar o rascunho para o valor certo, ou apagá-lo se a encomenda deixou de existir.",
    P().warning,
  )}
    ${stepsList([
    "Abra o rascunho na InvoiceXpress.",
    "Corrija-o para o valor efectivamente cobrado — ou apague-o, se o reembolso foi total.",
    "Se o documento devia ter sido finalizado antes do reembolso, active o Auto Finalizar para as próximas encomendas.",
  ])}
    ${orderClientBlock(input.orderRef, input.clientName)}
    ${d.invoiceId ? paragraph(`Documento: <strong>${escapeHtml(String(d.invoiceId))}</strong>`) : ""}
    ${affectedIdsBlock(input.affectedIds)}
  `;
  return {
    subject: "[Rioko 2.0] Reembolso sobre um rascunho — sem nota de crédito",
    html: shell({
      title: "Reembolso sobre um rascunho",
      bodyHtml: body,
      ...baseInput(input),
    }),
  };
}

export function tplBookingCancelledAfterInvoice(input: IncidentTemplateInput): RenderedTemplate {
  const d = (input.detail ?? {}) as Record<string, any>;
  const finalized: string[] = Array.isArray(d.finalized) ? d.finalized.map(String) : [];
  const body = `
    ${paragraph(escapeHtml(input.summary))}
    ${calloutBox(
    "Porque não foi anulado automaticamente",
    "Um documento finalizado está fiscalmente fechado e comunicado à AT — não pode ser apagado. "
    + "A única forma correcta de o anular é emitir uma nota de crédito, e essa decisão é sua. "
    + "Os rascunhos da mesma reserva, esses, já foram removidos automaticamente.",
    P().warning,
  )}
    ${stepsList([
    "Confirme no Lodgify que a reserva está mesmo cancelada.",
    "Emita uma nota de crédito no destino para o(s) documento(s) abaixo.",
    "Se o cancelamento implicou penalização cobrada ao hóspede, credite só a diferença.",
  ])}
    ${orderClientBlock(input.orderRef, input.clientName)}
    ${finalized.length ? paragraph(`Documentos finalizados: <strong>${escapeHtml(finalized.join(", "))}</strong>`) : ""}
    ${affectedIdsBlock(input.affectedIds)}
  `;
  return {
    subject: "[Rioko 2.0] Reserva cancelada com factura já finalizada",
    html: shell({
      title: "Reserva cancelada depois de facturada",
      bodyHtml: body,
      ...baseInput(input),
    }),
  };
}

export function tplLodgifyPaymentNotMarked(input: IncidentTemplateInput): RenderedTemplate {
  const d = (input.detail ?? {}) as Record<string, any>;
  const body = `
    ${paragraph(escapeHtml(input.summary))}
    ${calloutBox(
    "Porque não foram facturadas",
    "A factura só é emitida depois de o pagamento estar registado no Lodgify — é isso que evita facturar "
    + "reservas que ainda podem ser canceladas. Nas reservas de canais (Airbnb, Booking.com) o dinheiro nunca "
    + "passa pelo Lodgify, por isso é preciso marcá-las como pagas à mão quando o canal transfere.",
    P().warning,
  )}
    ${stepsList([
    "Abra o Lodgify e confirme quais destas reservas já recebeu.",
    "Registe o pagamento nessas reservas.",
    "Nada mais a fazer: as facturas saem sozinhas na sincronização seguinte (até 30 min).",
  ])}
    ${d.oldest_departure ? paragraph(`Saída mais antiga por regularizar: <strong>${escapeHtml(String(d.oldest_departure).slice(0, 10))}</strong>`) : ""}
    ${d.value != null ? paragraph(`Valor total envolvido: <strong>${escapeHtml(String(d.value))}</strong>`) : ""}
    ${affectedIdsBlock(input.affectedIds)}
  `;
  return {
    subject: "[Rioko 2.0] Reservas terminadas sem pagamento registado no Lodgify",
    html: shell({
      title: "Pagamentos por registar no Lodgify",
      bodyHtml: body,
      ...baseInput(input),
    }),
  };
}

export function tplSubscriptionInactive(input: IncidentTemplateInput): RenderedTemplate {
  const body = `
    ${paragraph("A subscrição Kapta associada à sua conta está inactiva. <strong>O Rioko 2.0 está a pausar a emissão de facturas</strong> até a situação ser regularizada.", { strong: true })}
    ${calloutBox("Acção necessária", "Pagamentos continuam a chegar mas não estão a ser facturados.", P().critical)}
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
    ${calloutBox("Causa provável", "Erro persistente do lado do sistema de destino ou dados da encomenda inconsistentes.", P().error)}
    ${aiDiagnosisBlock(input.aiDiagnosis, input.aiSuggestedFix)}
    ${stepsList([
      "Verifique o detalhe técnico abaixo.",
      "Após corrigir, reexecute manualmente em Dev Mode.",
    ])}
    ${orderClientBlock(input.orderRef, input.clientName)}
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
    ${calloutBox("Causa provável", "O segredo de assinatura no Rioko 2.0 não coincide com o configurado em Shopify/Stripe. Isto bloqueia <strong>todas</strong> as facturas até ser corrigido.", P().critical)}
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

export function tplReconcileDrift(input: IncidentTemplateInput): RenderedTemplate {
  const body = `
    ${paragraph("O total da factura que íamos emitir não coincidia com o valor pago. Abortámos a emissão antes de gerar um documento fiscal com valor errado.")}
    ${calloutBox("Causa provável", "Configuração incorrecta de IVA (incluído vs excluído) num produto específico, ou taxa de IVA reportada pela Shopify diferente da real. Pode ser corrigido com overrides por SKU em Integrações → InvoiceXpress → Gerir overrides.", P().critical)}
    ${aiDiagnosisBlock(input.aiDiagnosis, input.aiSuggestedFix)}
    ${stepsList([
      "Verificar o detalhe abaixo para identificar o SKU.",
      "Abrir Integrações → Gerir overrides e adicionar override para o SKU (tax_rate ou vat_inclusion).",
      "Reemitir a encomenda em Dev Mode.",
    ])}
    ${orderClientBlock(input.orderRef, input.clientName)}
    ${affectedIdsBlock(input.affectedIds)}
    ${detailBlock(input.detail)}
    ${ctaButton("Abrir overrides", `${input.dashboardUrl ?? DEFAULT_DASHBOARD}/integrations/ix-overrides`)}
  `;
  return {
    subject: "[Rioko 2.0] Drift de total — factura não emitida",
    html: shell({
      title: "Drift de total — factura não emitida",
      preheader: "Bloqueámos a emissão para evitar valor errado.",
      bodyHtml: body,
      ...baseInput(input),
    }),
  };
}

export function tplCurrencyNotSupported(input: IncidentTemplateInput): RenderedTemplate {
  const body = `
    ${paragraph("Recebemos um pagamento numa moeda diferente de EUR. A factura não foi emitida porque a contabilidade portuguesa deve ser em EUR.")}
    ${aiDiagnosisBlock(input.aiDiagnosis, input.aiSuggestedFix)}
    ${stepsList([
      "Verifique se o cliente pagou numa moeda inesperada.",
      "Se quer aceitar moedas múltiplas, contacte-nos para implementarmos conversão.",
    ])}
    ${orderClientBlock(input.orderRef, input.clientName)}
    ${affectedIdsBlock(input.affectedIds)}
    ${detailBlock(input.detail)}
  `;
  return {
    subject: "[Rioko 2.0] Moeda não suportada — factura não emitida",
    html: shell({
      title: "Moeda não suportada",
      bodyHtml: body,
      ...baseInput(input),
    }),
  };
}

export function tplSimplifiedInvoiceDowngraded(input: IncidentTemplateInput): RenderedTemplate {
  const body = `
    ${paragraph("Uma regra de routing por tags pediu factura simplificada, mas esta venda não reúne as condições legais. Emitimos factura normal para não deixar a venda por facturar.")}
    ${aiDiagnosisBlock(input.aiDiagnosis, input.aiSuggestedFix)}
    ${stepsList([
      "A factura simplificada está limitada a 1.000 € (art. 40.º do CIVA) e não admite dados completos de cliente.",
      "Se o cliente indicou NIF, a factura tem de ser completa.",
      "Se isto acontece com frequência, ajuste a regra para outro tipo de documento.",
    ])}
    ${orderClientBlock(input.orderRef, input.clientName)}
    ${affectedIdsBlock(input.affectedIds)}
    ${detailBlock(input.detail)}
  `;
  return {
    subject: "[Rioko 2.0] Factura simplificada convertida em factura normal",
    html: shell({
      title: "Factura simplificada não aplicável",
      preheader: "A venda foi facturada — mas não como simplificada.",
      bodyHtml: body,
      ...baseInput(input),
    }),
  };
}

/**
 * Ops-only. The document EXISTS and the merchant is not being asked to do
 * anything — this is us discovering that the destination stored something other
 * than what we sent, which is a fault in our integration or in theirs.
 */
export function tplDocumentDrift(input: IncidentTemplateInput): RenderedTemplate {
  const body = `
    ${paragraph("Emitimos o documento e, ao relê-lo no destino, ele não está como o enviámos. O documento existe — o que difere é o que lá ficou guardado.")}
    ${calloutBox("Porque é que isto importa", "A referência é a chave de idempotência entre nós e o destino: guardada diferente, perguntar \\\"já emitiste isto?\\\" passa a devolver a resposta errada, e daí saem faturas em falta ou duplicadas. O código de isenção é o que segue no SAF-T para a AT. Um total diferente significa um documento fiscal que não vale o que o cliente pagou.", P().critical)}
    ${aiDiagnosisBlock(input.aiDiagnosis, input.aiSuggestedFix)}
    ${stepsList([
      "Ver no detalhe abaixo que campo divergiu e os dois valores.",
      "Confirmar no destino se o documento está fechado — um documento fechado só se corrige com nota de crédito e reemissão.",
      "Se o campo for a referência, verificar se outras vendas da mesma ligação partilham o mesmo valor.",
    ])}
    ${orderClientBlock(input.orderRef, input.clientName)}
    ${affectedIdsBlock(input.affectedIds)}
    ${detailBlock(input.detail)}
  `;
  return {
    subject: "[Rioko 2.0] Documento ficou diferente do que enviámos",
    html: shell({
      title: "Divergência entre o enviado e o guardado",
      preheader: "O documento existe, mas o destino guardou outra coisa.",
      bodyHtml: body,
      ...baseInput(input),
    }),
  };
}

/**
 * Our own Lodgify egress relay is not answering.
 *
 * OPS-ONLY: `lodgify_relay_down` is not in MERCHANT_ACTIONABLE_KINDS, so this
 * never reaches a merchant — it exists for the ops digest. The copy is written
 * for whoever is on call, and it names the rollback, because the failure mode
 * this guards against is a Saturday-night outage nobody diagnoses until Monday.
 */
export function tplLodgifyRelayDown(input: IncidentTemplateInput): RenderedTemplate {
  const body = `
    ${paragraph("As chamadas à API da Lodgify saem por um relay com IP fixo (é o único endereço que a Lodgify aceita). Esse relay não respondeu, por isso nenhuma reserva está a ser sincronizada nem facturada.")}
    ${calloutBox("Causa provável", "Máquina do relay em baixo, plataforma indisponível, ou LODGIFY_GATEWAY_URL/KEY em falta no worker.", P().error)}
    ${stepsList([
      "fly status --app rioko-lodgify-relay — as duas máquinas devem estar started e healthy.",
      "curl https://rioko-lodgify-relay.fly.dev/healthz — deve responder 200 sem segredo.",
      "wrangler secret list — confirmar que LODGIFY_GATEWAY_KEY não desapareceu num deploy.",
      "Rollback, se for preciso ganhar tempo: LODGIFY_EGRESS_MODE=\"direct\". Volta ao estado bloqueado, sem introduzir falha nova.",
    ])}
    ${affectedIdsBlock(input.affectedIds)}
  `;
  return {
    subject: "[Rioko 2.0] Relay de saída da Lodgify em baixo",
    html: shell({
      title: "Relay de saída da Lodgify em baixo",
      preheader: "Sem sincronização de reservas enquanto durar.",
      bodyHtml: body,
      ...baseInput(input),
    }),
  };
}

export function renderIncidentTemplate(kind: IncidentKind, input: IncidentTemplateInput): RenderedTemplate {
  switch (kind) {
    case "document_drift": return tplDocumentDrift(input);
    case "auth_failure_destination": return tplAuthFailureDestination(input);
    case "auth_failure_source": return tplAuthFailureSource(input);
    case "destination_reject": return tplDestinationReject(input);
    case "normalize_fail": return tplNormalizeFail(input);
    case "nif_invalid": return tplNifInvalid(input);
    case "nif_invalid_draft": return tplNifInvalidDraft(input);
    case "credit_note_on_draft": return tplCreditNoteOnDraft(input);
    case "booking_cancelled_after_invoice": return tplBookingCancelledAfterInvoice(input);
    case "lodgify_payment_not_marked": return tplLodgifyPaymentNotMarked(input);
    case "subscription_inactive": return tplSubscriptionInactive(input);
    case "queue_retry_exhausted": return tplQueueRetryExhausted(input);
    case "webhook_invalid_signature": return tplWebhookInvalidSignature(input);
    case "vies_unconfirmed": return tplViesUnconfirmed(input);
    case "reconcile_drift": return tplReconcileDrift(input);
    case "currency_not_supported": return tplCurrencyNotSupported(input);
    case "simplified_invoice_downgraded": return tplSimplifiedInvoiceDowngraded(input);
    case "lodgify_relay_down": return tplLodgifyRelayDown(input);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// InvoiceXpress document-quota emails (own design — NOT the incident shell).
// "warning" = 90% of the plan limit; "reached" = limit hit, invoicing blocked.
// Dark-mode-safe: force-* / *-bg classes survive Gmail mobile's colour rewrite.
// ──────────────────────────────────────────────────────────────────────────

export interface QuotaEmailInput {
  kind: "warning" | "reached";
  merchantName: string;
  ixAccount: string;
  periodStart: string;          // "DD/MM/YYYY"
  periodEnd: string;
  /** When both > 0, exact counts are shown; otherwise an honest label. */
  used?: number;
  limit?: number;
  upgradeUrl?: string;          // defaults to the InvoiceXpress pricing page
  dashboardUrl?: string;
}

export function renderQuotaEmail(input: QuotaEmailInput): RenderedTemplate {
  const Q = { boxBg: P().chipBg, track: P().borderSubtle, btnA: "#8dc63f", btnB: "#4f9d2c", btn: "#5fae31", red: P().critical, amber: P().warning };
  const reached = input.kind === "reached";
  const accent = reached ? Q.red : Q.amber;
  const fAccent = reached ? "f-red" : "f-amber";
  const barClass = reached ? "bar-red" : "bar-amber";
  const chip = reached ? "LIMITE ATINGIDO" : "AVISO";
  const title = reached ? "Limite de faturas atingido — emissão bloqueada" : "Limite de faturas quase atingido";
  const subject = reached
    ? `🔴 Faturação bloqueada — limite InvoiceXpress atingido (${input.merchantName})`
    : `🟠 90% do limite de faturas InvoiceXpress (${input.merchantName})`;
  const upgradeUrl = input.upgradeUrl || "https://invoicexpress.com/planos-precos/";
  const dashboardUrl = input.dashboardUrl || DEFAULT_DASHBOARD;
  const known = (input.limit ?? 0) > 0;
  const used = input.used ?? 0, limit = input.limit ?? 0;
  const pct = known ? Math.round((used / limit) * 100) : (reached ? 100 : 90);
  const remaining = known ? Math.max(0, limit - used) : 0;
  const countLabel = known ? `${used} / ${limit}` : (reached ? "Limite atingido" : "Quase no limite");
  const f = Math.max(2, Math.min(100, pct));

  const style = `<style>
    [data-ogsc] .f-white,[data-ogsc] .f-white *{color:${P().textStrong}!important}
    [data-ogsc] .f-text,[data-ogsc] .f-text *{color:${P().text}!important}
    [data-ogsc] .f-muted,[data-ogsc] .f-muted *{color:${P().muted}!important}
    [data-ogsc] .f-blue,[data-ogsc] .f-blue *{color:${P().blue}!important}
    [data-ogsc] .f-red,[data-ogsc] .f-red *{color:${Q.red}!important}
    [data-ogsc] .f-amber,[data-ogsc] .f-amber *{color:${Q.amber}!important}
    [data-ogsc] .f-btn,[data-ogsc] .f-btn *{color:#ffffff!important}
    [data-ogsb] .header-bg{background-color:${P().headerBg}!important;background-image:${P().bgGradient}!important}
    [data-ogsb] .card-bg{background-color:${P().cardBg}!important}
    [data-ogsb] .footer-bg{background-color:${P().cardBgAlt}!important}
    [data-ogsb] .box-bg{background-color:${Q.boxBg}!important}
    [data-ogsb] .track-bg{background-color:${Q.track}!important}
    [data-ogsb] .btn-bg{background-color:${Q.btn}!important;background-image:linear-gradient(90deg,${Q.btnA},${Q.btnB})!important}
    [data-ogsb] .bar-red{background-color:${Q.red}!important}[data-ogsb] .bar-amber{background-color:${Q.amber}!important}
    @media (prefers-color-scheme: dark){
      .f-white,.f-white *{color:${P().textStrong}!important}.f-text,.f-text *{color:${P().text}!important}
      .f-muted,.f-muted *{color:${P().muted}!important}.f-blue,.f-blue *{color:${P().blue}!important}
      .f-red,.f-red *{color:${Q.red}!important}.f-amber,.f-amber *{color:${Q.amber}!important}.f-btn,.f-btn *{color:#ffffff!important}
      .header-bg{background-color:${P().headerBg}!important}.card-bg{background-color:${P().cardBg}!important}
      .footer-bg{background-color:${P().cardBgAlt}!important}.box-bg{background-color:${Q.boxBg}!important}
      .track-bg{background-color:${Q.track}!important}.btn-bg{background-color:${Q.btn}!important}
      .bar-red{background-color:${Q.red}!important}.bar-amber{background-color:${Q.amber}!important}
    }
  </style>`;

  const lead = reached
    ? `A conta InvoiceXpress associada a <b class="f-white" style="color:${P().textStrong}">${escapeHtml(input.merchantName)}</b> atingiu o <b class="f-red" style="color:${Q.red}">limite de documentos</b> do plano para o período atual. <b class="f-white" style="color:${P().textStrong}">Novas faturas não estão a ser emitidas.</b>`
    : `A conta InvoiceXpress associada a <b class="f-white" style="color:${P().textStrong}">${escapeHtml(input.merchantName)}</b> já usou <b class="f-amber" style="color:${Q.amber}">${pct}%</b> do limite de documentos do plano para o período atual. Quando o limite for atingido, a emissão de faturas pára automaticamente.`;
  const action = reached
    ? `Para <b class="f-white" style="color:${P().textStrong}">retomar a faturação imediatamente</b>, aumente o plano InvoiceXpress. Em alternativa, o limite reinicia no início do próximo período (${escapeHtml(input.periodEnd)}) — mas até lá as vendas ficam por faturar.`
    : `Recomendamos aumentar o plano InvoiceXpress antes de atingir o limite, para não interromper a emissão de faturas.`;

  const usageBar = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 0"><tr>
    <td class="track-bg" bgcolor="${Q.track}" style="background-color:${Q.track};border-radius:8px;padding:4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td class="${barClass}" width="${f}%" bgcolor="${accent}" style="background-color:${accent};height:14px;border-radius:6px;font-size:0;line-height:0">&nbsp;</td>
      <td width="${100 - f}%" style="font-size:0;line-height:0">&nbsp;</td></tr></table></td></tr></table>`;

  const body = `
  <p class="f-text" style="margin:0 0 18px;font-size:15px;line-height:1.65;color:${P().text}">${lead}</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="box-bg" bgcolor="${Q.boxBg}" style="background-color:${Q.boxBg};border:1px solid ${P().border};border-radius:12px;margin:0 0 22px"><tr><td style="padding:18px 20px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td class="f-muted" style="font-size:13px;color:${P().muted}"><font color="${P().muted}">Documentos usados neste período</font></td>
      <td class="${fAccent}" align="right" style="font-size:13px;color:${accent};font-weight:700"><font color="${accent}">${countLabel}</font></td></tr></table>
    ${usageBar}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px"><tr>
      <td class="f-muted" style="font-size:12px;color:${P().muted}"><font color="${P().muted}">Período: </font><span class="f-text" style="font-family:ui-monospace,Menlo,monospace;color:${P().text}"><font color="${P().text}">${escapeHtml(input.periodStart)} → ${escapeHtml(input.periodEnd)}</font></span></td>
      <td align="right" style="font-size:12px">${reached ? `<span class="f-red" style="color:${Q.red};font-weight:600"><font color="${Q.red}">0 restantes</font></span>` : (known ? `<span class="f-muted" style="color:${P().muted}"><font color="${P().muted}">${remaining} restantes</font></span>` : "")}</td></tr></table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:6px"><tr>
      <td class="f-muted" style="font-size:12px;color:${P().muted}"><font color="${P().muted}">Conta InvoiceXpress: </font><span class="f-text" style="font-family:ui-monospace,Menlo,monospace;color:${P().text}"><font color="${P().text}">${escapeHtml(input.ixAccount)}</font></span></td></tr></table>
  </td></tr></table>
  <p class="f-text" style="margin:0 0 24px;font-size:14px;line-height:1.65;color:${P().text}">${action}</p>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto"><tr>
    <td class="btn-bg" align="center" bgcolor="${Q.btn}" style="background-color:${Q.btn};background-image:linear-gradient(90deg,${Q.btnA},${Q.btnB});border-radius:10px">
      <a href="${escapeHtml(upgradeUrl)}" class="f-btn" style="display:inline-block;padding:13px 26px;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none"><font color="#ffffff">Aumentar plano InvoiceXpress →</font></a>
    </td></tr></table>
  <p style="margin:14px 0 0;text-align:center;font-size:13px"><a href="${escapeHtml(dashboardUrl)}" class="f-blue" style="color:${P().blue};text-decoration:none;font-weight:500"><font color="${P().blue}">Ver no painel Rioko</font></a></p>`;

  const html = `<!doctype html><html lang="pt-PT"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="${P().colorScheme}"><meta name="supported-color-schemes" content="${P().colorScheme}"><title>${escapeHtml(title)}</title>${style}</head>
<body style="margin:0;padding:0;background:${P().pageBg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:${P().text};-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden">${reached ? "Faturação bloqueada: a conta InvoiceXpress atingiu o limite de documentos do plano." : "A conta InvoiceXpress está a 90% do limite de documentos do plano."}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${P().pageBg}" style="background-color:${P().pageBg};padding:32px 16px"><tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="card-bg" bgcolor="${P().cardBg}" style="max-width:600px;width:100%;background-color:${P().cardBg};border-radius:14px;overflow:hidden">
    <tr><td class="header-bg" bgcolor="${P().headerBg}" style="background-color:${P().headerBg};background-image:${P().bgGradient};padding:28px 32px 24px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td valign="middle"><img src="${LOGO_WHITE}" alt="Rioko 2.0" width="140" style="display:block;border:0;max-width:140px;height:auto"></td>
        <td valign="middle" align="right"><span style="display:inline-block;background:${accent};color:#1a1206;font-size:11px;font-weight:700;letter-spacing:0.5px;padding:4px 11px;border-radius:12px"><font color="#1a1206">${chip}</font></span></td></tr></table>
      <div style="margin-top:20px"><h1 class="f-white" style="margin:0;color:${P().textStrong};font-size:22px;font-weight:600;letter-spacing:-0.3px;line-height:1.3"><span style="color:${P().textStrong}">${escapeHtml(title)}</span></h1>
        <p class="f-muted" style="margin:6px 0 0;color:${P().muted};font-size:13px"><font color="${P().muted}">${escapeHtml(input.merchantName)} · Shopify → InvoiceXpress</font></p></div>
      <div style="height:3px;width:100%;background-color:${P().blue};background-image:linear-gradient(90deg, ${P().blue}, ${P().purple});margin-top:24px"></div></td></tr>
    <tr><td class="card-bg" bgcolor="${P().cardBg}" style="background-color:${P().cardBg};padding:32px">${body}</td></tr>
    <tr><td class="footer-bg" bgcolor="${P().cardBgAlt}" style="background-color:${P().cardBgAlt};padding:24px 32px;border-top:1px solid ${P().border};text-align:center">
      <p class="f-muted" style="margin:0;font-size:13px;color:${P().muted};line-height:1.6"><font color="${P().muted}">Precisa de ajuda? </font><a href="${escapeHtml(DEFAULT_HELP_URL)}" class="f-blue" style="color:${P().blue};text-decoration:none;font-weight:500"><font color="${P().blue}">Contacte a equipa Rioko 2.0</font></a></p>
      <p class="f-muted" style="margin:12px 0 0;font-size:11px;color:${P().muted}"><font color="${P().muted}">Rioko 2.0 by <a href="https://kapta.pt" style="color:${P().muted}"><font color="${P().muted}">Kapta</font></a> · Notificação automática · Não responda a este email</font></p></td></tr>
  </table></td></tr></table></body></html>`;

  return { subject, html };
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
  const merchant = input.merchantName ? `<p style="margin:6px 0 0;color:${P().muted};font-size:13px">${escapeHtml(input.merchantName)}</p>` : "";

  const rows = input.incidents.map(i => {
    const sevColor = severityColor(i.severity);
    return `<tr>
      <td style="padding:14px 0;border-bottom:1px solid ${P().border};vertical-align:top;width:8px">
        <div style="width:6px;height:36px;background:${sevColor};border-radius:3px"></div>
      </td>
      <td style="padding:14px 12px;border-bottom:1px solid ${P().border};vertical-align:top">
        <div style="font-size:11px;font-weight:600;color:${P().muted};letter-spacing:0.3px;text-transform:uppercase;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(i.kind)}</div>
        <div style="font-size:14px;color:${P().text};margin-top:3px;line-height:1.45">${escapeHtml(i.summary)}</div>
      </td>
      <td style="padding:14px 0;border-bottom:1px solid ${P().border};vertical-align:top;text-align:right;font-size:13px;color:${P().muted};white-space:nowrap">
        ${i.occurrences}×
      </td>
    </tr>`;
  }).join("");

  const html = `<!doctype html>
<html lang="pt-PT">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="${P().colorScheme}">
  <meta name="supported-color-schemes" content="${P().colorScheme}">
</head>
<body style="margin:0;padding:0;background:${P().pageBg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:${P().text}">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${input.incidents.length} incidente(s) em aberto necessitam de atenção.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${P().pageBg};padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;width:100%;background:${P().cardBg};border-radius:14px;overflow:hidden">
        <tr><td class="header-bg" bgcolor="${P().headerBg}" style="background-color:${P().headerBg};background-image:${P().bgGradient};padding:28px 32px 24px">
          <img src="${LOGO_WHITE}" alt="Rioko 2.0" width="140" height="auto" style="display:block;border:0;max-width:140px;height:auto">
          <h1 class="force-white" style="margin:20px 0 0;color:#ffffff !important;font-size:22px;font-weight:600;letter-spacing:-0.3px"><font color="#ffffff">Resumo diário de incidentes</font></h1>
          ${merchant}
          <div style="height:3px;width:100%;background-color:${P().blue};background-image:linear-gradient(90deg, ${P().blue}, ${P().purple});margin-top:24px"></div>
        </td></tr>
        <tr><td class="card-bg" bgcolor="${P().cardBg}" style="background-color:${P().cardBg};padding:28px 32px;color:${P().text}">
          <p style="margin:0 0 20px;color:${P().muted};font-size:14px">
            <font color="${P().text}"><strong>${input.incidents.length}</strong></font> <font color="${P().muted}">incidente${input.incidents.length === 1 ? "" : "s"} em aberto ${input.incidents.length === 1 ? "necessita" : "necessitam"} de atenção.</font>
          </p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tbody>${rows}</tbody>
          </table>
          <div style="margin-top:24px">
            ${ctaButton("Ver no painel", `${dashboardUrl}/superadmin/incidents`)}
          </div>
        </td></tr>
        <tr><td class="footer-bg" bgcolor="${P().cardBgAlt}" style="background-color:${P().cardBgAlt};padding:24px 32px;border-top:1px solid ${P().border};text-align:center">
          <p class="force-muted" style="margin:0;font-size:13px;color:${P().muted};line-height:1.6">
            <font color="${P().muted}">Precisa de ajuda?</font> <a href="${escapeHtml(helpUrl)}" class="force-blue" style="color:${P().blue};text-decoration:none;font-weight:500"><font color="${P().blue}">Contacte a equipa Rioko 2.0</font></a>
          </p>
          <p class="force-muted" style="margin:12px 0 0;font-size:11px;color:${P().muted}">
            <font color="${P().muted}">Rioko 2.0 by <a href="https://kapta.pt" style="color:${P().muted};text-decoration:underline"><font color="${P().muted}">Kapta</font></a> · Notificação automática</font>
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

// ──────────────────────────────────────────────────────────────────────────
// Weekly AI cross-incident pattern report (ops-facing)
// ──────────────────────────────────────────────────────────────────────────

export interface PatternReportItem {
  title: string;
  detail: string;
  affected_count?: number;
  suggested_action: string;
}

/**
 * Ops-only weekly report of systemic patterns the AI found across the week's
 * incidents. Clearly labelled AI-generated. Goes to KAPTA_DEV_EMAILS.
 */
export function tplPatternReport(input: {
  summary: string;
  patterns: PatternReportItem[];
  totalIncidents: number;
  weekLabel: string;
  dashboardUrl?: string;
}): RenderedTemplate {
  const dashboardUrl = input.dashboardUrl ?? DEFAULT_DASHBOARD;
  const cards = input.patterns.map((p) => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${P().chipBg};border-left:3px solid ${P().purple};border-radius:6px;margin:0 0 14px">
      <tr><td style="padding:14px 18px">
        <div style="font-size:15px;font-weight:600;color:${P().text}">${escapeHtml(p.title)}${p.affected_count ? ` <span style="font-size:12px;color:${P().muted};font-weight:500">· ${p.affected_count}×</span>` : ""}</div>
        <div style="font-size:14px;line-height:1.6;color:${P().text};margin-top:6px">${escapeHtml(p.detail)}</div>
        ${p.suggested_action ? `<div style="font-size:13px;line-height:1.6;color:${P().text};margin-top:8px"><strong>Ação:</strong> ${escapeHtml(p.suggested_action)}</div>` : ""}
      </td></tr>
    </table>`).join("");

  const body = `
    ${paragraph(escapeHtml(input.summary))}
    ${sectionTitle(`Padrões (${input.patterns.length}) · ${input.totalIncidents} incidentes na semana`)}
    ${cards || paragraph("Sem padrões sistémicos identificados esta semana.")}
    <div style="margin-top:8px;font-size:11px;color:${P().muted}">Gerado por IA · meramente indicativo · não substitui verificação humana</div>
    ${ctaButton("Ver incidentes", `${dashboardUrl}/superadmin/incidents`)}
  `;
  return {
    subject: `[Rioko 2.0] Relatório semanal de padrões — ${input.weekLabel}`,
    html: shell({
      title: "Relatório semanal de padrões (IA)",
      preheader: input.summary.slice(0, 120),
      bodyHtml: body,
      helpUrl: DEFAULT_HELP_URL,
      dashboardUrl,
      firstSeenAt: input.weekLabel,
      lastSeenAt: input.weekLabel,
      occurrences: 1,
    }),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Weekly merchant digest — still-unprocessed invoices (customer-facing)
// ──────────────────────────────────────────────────────────────────────────

export interface WeeklyUnprocessedItem {
  kind: string;
  summary: string;
  lastSeenAt: string;
  severity?: Severity;
  /** Order/payment references still missing an invoice (empty for account-level). */
  missingIds: string[];
}

/**
 * Customer-facing weekly email listing the merchant's OWN sales that were
 * received but have no invoice issued yet. Friendlier framing than the ops
 * digest: no `kind` jargon in the body, links to the dashboard (not /superadmin),
 * and one row per still-unprocessed incident with the affected order references.
 */
export function tplWeeklyUnprocessed(input: {
  merchantName?: string;
  items: WeeklyUnprocessedItem[];
  totalMissing: number;
  /** Refunds whose credit note failed. Listed apart — the sale IS invoiced, so
   * calling these "vendas por faturar" would be false. */
  creditItems?: WeeklyUnprocessedItem[];
  totalCreditMissing?: number;
  helpUrl?: string;
  dashboardUrl?: string;
}): RenderedTemplate {
  const helpUrl = input.helpUrl ?? DEFAULT_HELP_URL;
  const dashboardUrl = input.dashboardUrl ?? DEFAULT_DASHBOARD;
  const merchant = input.merchantName
    ? `<p style="margin:6px 0 0;color:${P().muted};font-size:13px">${escapeHtml(input.merchantName)}</p>`
    : "";

  const renderRows = (items: WeeklyUnprocessedItem[]) => items.map((it) => {
    const sevColor = severityColor(it.severity);
    const idChips = it.missingIds.length
      ? `<div style="margin-top:8px">${it.missingIds.slice(0, 12).map((id) =>
          `<span style="display:inline-block;background:${P().chipBg};border:1px solid ${P().borderSubtle};color:${P().text};font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;padding:4px 8px;border-radius:5px;margin:0 4px 4px 0">${escapeHtml(id)}</span>`
        ).join("")}${it.missingIds.length > 12 ? `<span style="font-size:12px;color:${P().muted}">… e mais ${it.missingIds.length - 12}</span>` : ""}</div>`
      : "";
    return `<tr>
      <td style="padding:14px 0;border-bottom:1px solid ${P().border};vertical-align:top;width:8px">
        <div style="width:6px;height:36px;background:${sevColor};border-radius:3px"></div>
      </td>
      <td style="padding:14px 12px;border-bottom:1px solid ${P().border};vertical-align:top">
        <div style="font-size:14px;color:${P().text};line-height:1.45">${escapeHtml(it.summary)}</div>
        ${idChips}
      </td>
    </tr>`;
  }).join("");

  const rows = renderRows(input.items);
  const creditItems = input.creditItems ?? [];
  const creditRows = renderRows(creditItems);

  const n = input.totalMissing;
  const plural = n === 1 ? "" : "s";
  const nc = input.totalCreditMissing ?? 0;
  const ncPlural = nc === 1 ? "" : "s";

  // The credit-note block only renders when there is something to say. Its
  // wording never claims the sale is unbilled — what is missing is the NC.
  const creditSection = creditRows
    ? `<div style="margin-top:28px;padding-top:20px;border-top:1px solid ${P().border}">
            <p style="margin:0 0 8px;color:${P().text};font-size:15px;line-height:1.6">
              <font color="${P().text}">Estes reembolsos <strong>não geraram nota de crédito</strong>. A fatura original existe; falta o documento que a corrige.</font>
            </p>
            <p style="margin:0 0 16px;color:${P().muted};font-size:14px">
              <font color="${P().text}"><strong>${nc}</strong></font> <font color="${P().muted}">reembolso${ncPlural} sem nota de crédito.</font>
            </p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tbody>${creditRows}</tbody>
            </table>
          </div>`
    : "";

  // A merchant can have only credit-note failures and zero unbilled sales —
  // then the whole email is about notas de crédito, headline included.
  const salesOnly = n > 0 || creditRows === "";
  const heading = salesOnly ? "Faturas por emitir" : "Notas de crédito por emitir";
  const subject = salesOnly
    ? `[Rioko 2.0] ${n} fatura${plural} por emitir`
    : `[Rioko 2.0] ${nc} nota${ncPlural} de crédito por emitir`;
  const preheader = salesOnly
    ? `${n} venda${plural} recebida${plural} sem fatura emitida.`
    : `${nc} reembolso${ncPlural} sem nota de crédito emitida.`;
  const html = `<!doctype html>
<html lang="pt-PT">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="${P().colorScheme}">
  <meta name="supported-color-schemes" content="${P().colorScheme}">
</head>
<body style="margin:0;padding:0;background:${P().pageBg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:${P().text}">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${preheader}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${P().pageBg};padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;width:100%;background:${P().cardBg};border-radius:14px;overflow:hidden">
        <tr><td class="header-bg" bgcolor="${P().headerBg}" style="background-color:${P().headerBg};background-image:${P().bgGradient};padding:28px 32px 24px">
          <img src="${LOGO_WHITE}" alt="Rioko 2.0" width="140" height="auto" style="display:block;border:0;max-width:140px;height:auto">
          <h1 class="force-white" style="margin:20px 0 0;color:#ffffff !important;font-size:22px;font-weight:600;letter-spacing:-0.3px"><font color="#ffffff">${heading}</font></h1>
          ${merchant}
          <div style="height:3px;width:100%;background-color:${P().blue};background-image:linear-gradient(90deg, ${P().blue}, ${P().purple});margin-top:24px"></div>
        </td></tr>
        <tr><td class="card-bg" bgcolor="${P().cardBg}" style="background-color:${P().cardBg};padding:28px 32px;color:${P().text}">
          ${rows ? `<p style="margin:0 0 8px;color:${P().text};font-size:15px;line-height:1.6">
            <font color="${P().text}">Estas vendas foram recebidas mas <strong>ainda não têm fatura emitida</strong>. Reveja-as e reemita no painel.</font>
          </p>
          <p style="margin:0 0 20px;color:${P().muted};font-size:14px">
            <font color="${P().text}"><strong>${n}</strong></font> <font color="${P().muted}">venda${plural} por faturar.</font>
          </p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tbody>${rows}</tbody>
          </table>` : ""}
          ${creditSection}
          <div style="margin-top:24px">
            ${ctaButton("Abrir painel", dashboardUrl)}
          </div>
        </td></tr>
        <tr><td class="footer-bg" bgcolor="${P().cardBgAlt}" style="background-color:${P().cardBgAlt};padding:24px 32px;border-top:1px solid ${P().border};text-align:center">
          <p class="force-muted" style="margin:0;font-size:13px;color:${P().muted};line-height:1.6">
            <font color="${P().muted}">Precisa de ajuda?</font> <a href="${escapeHtml(helpUrl)}" class="force-blue" style="color:${P().blue};text-decoration:none;font-weight:500"><font color="${P().blue}">Contacte a equipa Rioko 2.0</font></a>
          </p>
          <p class="force-muted" style="margin:12px 0 0;font-size:11px;color:${P().muted}">
            <font color="${P().muted}">Rioko 2.0 by <a href="https://kapta.pt" style="color:${P().muted};text-decoration:underline"><font color="${P().muted}">Kapta</font></a> · Resumo semanal · Não responda a este email</font>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, html };
}


// ──────────────────────────────────────────────────────────────────────────
// Account access (extra users)
// ──────────────────────────────────────────────────────────────────────────

export interface AccountInviteInput {
  /** Human name of the account they were invited into. */
  accountLabel: string;
  /** Address invited. */
  email: string;
  role: "admin" | "viewer";
  /** True when they already had a Rioko login, so access is already active and
   *  Clerk sent them no sign-up mail. */
  hasLogin: boolean;
  /** Clerk's invitation link, for someone who still has to create an account.
   *  We deliver it ourselves: Clerk's own mailer is a second delivery path we
   *  cannot see into, and it silently dropped invites. */
  inviteUrl?: string;
  dashboardUrl?: string;
  helpUrl?: string;
}

/** "You were invited to manage account X" — same brand shell as every other
 *  Rioko email, without the incident meta row. */
export function renderAccountInviteEmail(input: AccountInviteInput): RenderedTemplate {
  const dashboardUrl = input.dashboardUrl ?? DEFAULT_DASHBOARD;
  const account = escapeHtml(input.accountLabel);
  const permission = input.role === "admin"
    ? "administrador: pode configurar integrações, emitir e gerir a faturação"
    : "só leitura: vê tudo, não altera nada";

  const bodyHtml = [
    paragraph(`Foi convidado para gerir a conta <strong>${account}</strong> no Rioko.`),
    calloutBox("As suas permissões", escapeHtml(permission)),
    input.hasLogin
      ? paragraph(`Como já tem login Rioko com <strong>${escapeHtml(input.email)}</strong>, o acesso já está ativo: entre e a conta aparece na sua área.`)
      : paragraph(`Para entrar, crie a sua conta com <strong>${escapeHtml(input.email)}</strong>. O acesso a ${account} fica ligado automaticamente.`),
    ctaButton(
      input.hasLogin ? "Abrir o Rioko" : "Criar a minha conta",
      input.hasLogin ? dashboardUrl : (input.inviteUrl ?? dashboardUrl),
    ),
    input.hasLogin || !input.inviteUrl ? "" : paragraph(
      `<span style="font-size:12px;color:${P().muted}">Este link é pessoal e válido por 30 dias.</span>`,
    ),
    paragraph(`<span style="font-size:13px;color:${P().muted}">Se não estava à espera deste convite, ignore este email.</span>`),
  ].join("");

  return {
    subject: `Foi convidado para gerir a conta ${input.accountLabel} no Rioko`,
    html: shell({
      title: "Convite para gerir uma conta",
      preheader: `${input.accountLabel} deu-lhe acesso ao Rioko`,
      bodyHtml,
      merchantName: input.accountLabel,
      helpUrl: input.helpUrl ?? DEFAULT_HELP_URL,
      dashboardUrl,
      footerNote: "Convite de acesso · Não responda a este email",
    }),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Subscription payment failed — the client-facing dunning email.
// ──────────────────────────────────────────────────────────────────────────

export interface PaymentFailedInput {
  /** Human name of the account whose subscription failed to charge. */
  accountLabel: string;
  /** Where the card is replaced. A Stripe portal `payment_method_update` flow
   *  link when we could mint one, otherwise the hosted invoice page. */
  updateUrl: string;
  /** Stripe's hosted invoice page. Shown as a secondary link when it is not
   *  already the CTA, so the invoice can be paid on the spot with a new card. */
  invoiceUrl?: string;
  /** Amount due, already formatted for a human ("7,50 €"). */
  amountLabel?: string;
  /** Date of Stripe's next automatic retry, "DD/MM/YYYY". */
  nextAttemptLabel?: string;
  /** True when Stripe has no retry left: the next stop is suspension. */
  finalAttempt?: boolean;
  dashboardUrl?: string;
  helpUrl?: string;
}

/** "The subscription charge did not go through" — same brand shell, no incident
 *  meta row. The subscription is still active when this goes out: the email
 *  exists so it stays that way. */
export function renderPaymentFailedEmail(input: PaymentFailedInput): RenderedTemplate {
  const dashboardUrl = input.dashboardUrl ?? DEFAULT_DASHBOARD;
  const account = escapeHtml(input.accountLabel);
  const amount = input.amountLabel ? `<strong>${escapeHtml(input.amountLabel)}</strong>` : "o valor da subscrição";

  // What happens next is the whole point of the email, and it differs: Stripe
  // either retries on a known date, or has stopped retrying and the access is
  // about to go with it. Never promise a retry that is not coming.
  const consequence = input.finalAttempt
    ? calloutBox(
        "Sem novas tentativas automáticas",
        "Esta foi a última tentativa de cobrança. Sem um método de pagamento válido, a subscrição é suspensa e a emissão automática de documentos para.",
        P().error,
      )
    : calloutBox(
        "O que acontece a seguir",
        input.nextAttemptLabel
          ? `Voltamos a tentar cobrar a <strong>${escapeHtml(input.nextAttemptLabel)}</strong>. Se o método de pagamento for atualizado antes disso, a cobrança passa e não há qualquer interrupção.`
          : "Vamos voltar a tentar cobrar nos próximos dias. Se o método de pagamento for atualizado antes disso, a cobrança passa e não há qualquer interrupção.",
        P().warning,
      );

  const secondary = input.invoiceUrl && input.invoiceUrl !== input.updateUrl
    ? paragraph(
        `<span style="font-size:13px;color:${P().muted}">Prefere liquidar já esta fatura? ` +
        `<a href="${escapeHtml(input.invoiceUrl)}" style="color:${P().blue};text-decoration:none">Pagar a fatura em aberto</a>.</span>`,
      )
    : "";

  const bodyHtml = [
    paragraph(`A cobrança de ${amount} da subscrição Rioko de <strong>${account}</strong> não foi autorizada pelo cartão registado.`),
    paragraph("A subscrição continua ativa e a faturação automática mantém-se a funcionar. Só falta atualizar o método de pagamento, o que demora menos de um minuto:"),
    ctaButton("Atualizar método de pagamento", input.updateUrl),
    paragraph(
      `<span style="font-size:12px;color:${P().muted}">O link abre uma página segura da Stripe e não pede palavra-passe. ` +
      `Se já tiver expirado, pode fazer o mesmo no painel, em Faturação.</span>`,
    ),
    consequence,
    calloutBox(
      "Motivos mais comuns",
      "Cartão expirado ou substituído pelo banco; plafond insuficiente no momento da cobrança; autenticação do banco (3-D Secure) não confirmada.",
    ),
    secondary,
    paragraph(`<span style="font-size:13px;color:${P().muted}">Se já resolveu entretanto, ignore este email.</span>`),
  ].join("");

  return {
    subject: input.finalAttempt
      ? `Última tentativa falhada — atualize o pagamento da subscrição Rioko`
      : `O pagamento da subscrição Rioko não foi concluído`,
    html: shell({
      title: "O pagamento da subscrição não foi concluído",
      severity: input.finalAttempt ? "error" : "warning",
      preheader: `Atualize o método de pagamento${input.amountLabel ? ` (${input.amountLabel})` : ""} para manter a subscrição ativa.`,
      bodyHtml,
      merchantName: input.accountLabel,
      connectionLabel: "Subscrição Rioko",
      helpUrl: input.helpUrl ?? DEFAULT_HELP_URL,
      dashboardUrl,
      footerNote: "Faturação da subscrição",
    }),
  };
}
