import { Resend } from "resend";
import type { Env } from "../env";
import { redactSecrets } from "./redact";

/**
 * Sending a newsletter: one ordinary email per recipient, through Resend.
 *
 * It used to be a Resend Broadcast, so that Resend would own the unsubscribe.
 * That cost a segment per campaign on a plan that allows three, a topic, a
 * contact per address, and a test email that could never show what a recipient
 * would get. On 13/09/2026 the first real send died on the segment cap, then on
 * "no contacts", and the newsletter moved here.
 *
 * The two things a Broadcast filled per recipient are filled here instead:
 *
 * - `{{{contact.first_name|fallback}}}`: the recipient's first name, or the fallback;
 * - `{{{RESEND_UNSUBSCRIBE_URL}}}`: a link to rioko.online signed for this address,
 *   which records the opt-out in D1 (`newsletter_optouts`, migration 0060). The
 *   tag keeps its old name so the templates did not have to change.
 *
 * The opt-out is honoured where the audience is resolved, in the backoffice: an
 * address in that table never reaches this function. The same link goes in
 * `List-Unsubscribe` with the one-click header, which is the button Gmail and
 * Outlook put beside the sender.
 *
 * Still true, and still the point: an opt-out stops NEWSLETTERS only. Incident,
 * dunning and renewal mail goes out through sendEmail() and never reads that table.
 */

export interface NewsletterRecipient {
  email: string;
  first_name?: string | null;
  user_id?: string | null;
  label?: string | null;
  client_code?: string | null;
}

export interface NewsletterCandidate {
  email: string;
  sent: boolean;
  /** Resend's email id, to find this one message in its dashboard. */
  id?: string;
  error?: string;
}

export interface NewsletterResult {
  checked: number;
  sent: number;
  failed: number;
  skipped_invalid_email: number;
  scheduled_at: string | null;
  dry_run: boolean;
  candidates: NewsletterCandidate[];
}

export interface NewsletterOptions {
  slug: string;
  subject: string;
  html: string;
  previewText?: string;
  recipients: NewsletterRecipient[];
  /** ISO 8601. Omitted sends now. */
  scheduledAt?: string;
  /** Defaults to TRUE, like every other campaign runner in here. */
  dryRun?: boolean;
  /** Test seam. Production passes nothing and gets a real client. */
  client?: ResendLike;
  /** Test seam. Milliseconds between Resend calls; production uses RESEND_PACE_MS. */
  paceMs?: number;
}

/** Only what this service uses, so a test can stand in for it honestly. */
export interface ResendLike {
  emails: { send(p: any): Promise<any> };
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The one thing whose absence is not a cosmetic defect.
 *
 * The full legal check (sender identity, privacy link) lives in the backoffice,
 * beside the editor, where an operator can be told what to fix. This is the last
 * gate before the mail becomes unrecallable, and it guards the single string
 * that cannot be repaired afterwards: without it the recipient has no way out,
 * and every later send to them is unlawful.
 */
export const UNSUBSCRIBE_TAG = "{{{RESEND_UNSUBSCRIBE_URL}}}";

/** Where the signed link lands: a public backoffice route, on the sender's own domain. */
const UNSUBSCRIBE_BASE = "https://rioko.online/api/newsletter/unsubscribe";

/**
 * A campaign can be large; a runaway loop against a paid API cannot.
 * ponytail: the whole send runs inside one request, one paced call per
 * recipient, so a few hundred is the practical ceiling long before this one.
 * Move to a queue (or Resend's batch endpoint) before an audience gets there.
 */
const MAX_RECIPIENTS = 2000;

/** Between Resend calls: about six a second, under the team's ten, with room
 *  left for the transactional mail that shares the same limit. */
const RESEND_PACE_MS = 150;

export async function runNewsletterBroadcast(
  env: Env,
  opts: NewsletterOptions,
): Promise<NewsletterResult> {
  const dryRun = opts.dryRun !== false;

  if (!opts.html.includes(UNSUBSCRIBE_TAG)) {
    throw new Error(`Newsletter html is missing ${UNSUBSCRIBE_TAG}`);
  }
  if (!opts.subject.trim()) throw new Error("Newsletter subject is empty");
  if (opts.recipients.length > MAX_RECIPIENTS) {
    throw new Error(`Too many recipients: ${opts.recipients.length} > ${MAX_RECIPIENTS}`);
  }

  // The list arrives over HTTP from the backoffice. It is admin-authenticated,
  // which is not the same as trusted: re-validate here, and dedupe, because two
  // rows for one address means one person gets the same thing twice.
  const seen = new Set<string>();
  const valid: NewsletterRecipient[] = [];
  let skipped = 0;
  for (const r of opts.recipients) {
    const email = String(r?.email ?? "").trim().toLowerCase();
    if (!EMAIL_REGEX.test(email)) { skipped++; continue; }
    if (seen.has(email)) continue;
    seen.add(email);
    valid.push({ ...r, email });
  }

  const result: NewsletterResult = {
    checked: opts.recipients.length,
    sent: 0,
    failed: 0,
    skipped_invalid_email: skipped,
    scheduled_at: opts.scheduledAt ?? null,
    dry_run: dryRun,
    candidates: valid.map((r) => ({ email: r.email, sent: false })),
  };

  // A dry run touches Resend not at all.
  if (dryRun) return result;
  if (!valid.length) throw new Error("Newsletter has no valid recipients");

  // Without the key there is no link to sign, and a newsletter with a dead
  // unsubscribe link must not leave.
  const secret = env.ADMIN_API_KEY;
  if (!secret) throw new Error("ADMIN_API_KEY is not set, so no unsubscribe link can be signed");

  const resend = opts.client ?? (new Resend(env.RESEND_API_KEY) as unknown as ResendLike);
  const call = paced(opts.paceMs ?? RESEND_PACE_MS);
  const from = `Rioko <${env.RESEND_FROM_EMAIL ?? "noreply@rioko.online"}>`;

  // redactSecrets runs inside sendEmail() for every other email; this path does
  // not go through it, so it runs here. On the template, BEFORE the per-recipient
  // link goes in: the signature is exactly the kind of string it would blank.
  const subject = redactSecrets(opts.subject);
  const html = withPreheader(redactSecrets(opts.html), opts.previewText);

  for (const r of valid) {
    const card = result.candidates.find((c) => c.email === r.email)!;
    try {
      const link = `${UNSUBSCRIBE_BASE}?t=${await unsubscribeToken(secret, r.email)}`;
      const res = await call(() => resend.emails.send({
        from,
        to: r.email,
        replyTo: "suporte@kapta.pt",
        subject: personalise(subject, r, link),
        html: personalise(html, r, link),
        headers: {
          "List-Unsubscribe": `<${link}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
        ...(opts.scheduledAt ? { scheduledAt: opts.scheduledAt } : {}),
      }));
      if (errorOf(res)) throw new Error(`Resend: ${messageOf(errorOf(res))}`);
      card.sent = true;
      card.id = idOf(res) ?? undefined;
      result.sent++;
    } catch (e: any) {
      card.error = e?.message ?? String(e);
      result.failed++;
    }
  }

  if (result.sent === 0) {
    // The first reason leads: a whole list failing the same way (a daily quota,
    // an unverified domain) is the usual shape of this.
    const why = result.candidates.find((c) => c.error)?.error;
    throw new Error(`Nothing was sent${why ? `: ${why}` : ""}`);
  }
  return result;
}

/**
 * The two tags a Broadcast used to fill per recipient. Nothing else in triple
 * braces is touched.
 *
 * The greeting is written "Olá{{GREETING_NAME}}," with the space inside our own
 * placeholder, so a recipient with no name and no fallback gets "Olá," rather
 * than "Olá ,": the space before the tag goes with an empty value.
 */
export function personalise(text: string, r: NewsletterRecipient, unsubscribeLink: string): string {
  return text
    .replace(/( ?)\{\{\{contact\.first_name\|([^}]*)\}\}\}/g, (_m, space: string, fallback: string) => {
      const value = String(r.first_name ?? "").trim() || fallback;
      return value ? space + value : "";
    })
    .replaceAll(UNSUBSCRIBE_TAG, unsubscribeLink);
}

/**
 * `<email>.<signature>`, both base64url: HMAC-SHA256 over the address, keyed with
 * ADMIN_API_KEY under a label of its own, so the signature is good for this one
 * purpose and says nothing about the key. The backoffice verifies it
 * (backoffice/src/lib/newsletter-unsubscribe.ts); newsletter.test.ts checks the
 * two halves still agree.
 * ponytail: rotating ADMIN_API_KEY kills every link already delivered; give it a
 * secret of its own if that key ever rotates on a schedule.
 */
export async function unsubscribeToken(secret: string, email: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`newsletter-unsubscribe:${email}`));
  return `${b64url(enc.encode(email))}.${b64url(new Uint8Array(sig))}`;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The inbox line after the subject. A Broadcast took it as a field; a plain
 *  email only has the html, so it goes in as the first, hidden, element. */
function withPreheader(html: string, preview?: string): string {
  if (!preview?.trim()) return html;
  const div = `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escapeHtml(preview.trim())}</div>`;
  const body = html.match(/<body[^>]*>/i);
  return body ? html.replace(body[0], body[0] + div) : div + html;
}

function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/**
 * Resend calls one at a time, at least `ms` apart. A 429 is waited out up to
 * three times, a second longer each time, before its error is handed back like
 * any other.
 */
function paced(ms: number) {
  let last = 0;
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      const wait = last + ms - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      const res: any = await fn();
      if (!isRateLimited(errorOf(res)) || attempt >= 3) return res;
      if (ms > 0) await sleep(1000 * (attempt + 1));
    }
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isRateLimited(err: any): boolean {
  return Boolean(err) && (err.statusCode === 429 || err.name === "rate_limit_exceeded");
}

/** The SDK's errors are objects; `String()` of one is "[object Object]". */
function messageOf(err: unknown): string {
  if (typeof err === "string") return err;
  const m = (err as any)?.message;
  return m ? String(m) : JSON.stringify(err);
}

/** The SDK answers `{ data, error }`; older shapes answer the object directly. */
function idOf(res: any): string | null {
  return res?.data?.id ?? res?.id ?? null;
}
function errorOf(res: any): unknown {
  return res?.error ?? null;
}
