import { Resend } from "resend";
import type { Env } from "../env";

export interface SendEmailParams {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  html: string;
  text?: string;
  fromEmail?: string;
  fromName?: string;
  /** Override the provider chain for testing. */
  providerOverride?: "resend" | "mailchannels";
}

export interface SendEmailResult {
  ok: boolean;
  provider: "resend" | "mailchannels" | "none";
  status?: number;
  id?: string;
  detail?: string;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalize(addr: string | string[] | undefined): string[] {
  if (!addr) return [];
  const arr = Array.isArray(addr) ? addr : [addr];
  return arr.filter(e => typeof e === "string" && EMAIL_REGEX.test(e));
}

/**
 * Single email-sending entry point for the worker. Resolves provider at call
 * time: Resend if RESEND_API_KEY is set, else MailChannels. Returns a uniform
 * result regardless of which provider handled it.
 *
 * Caller is responsible for templating — pass already-rendered html (and
 * optional text). For incident emails, use email-templates.ts to build the
 * html string first.
 */
export async function sendEmail(env: Env, params: SendEmailParams): Promise<SendEmailResult> {
  const to = normalize(params.to);
  if (to.length === 0) return { ok: false, provider: "none", detail: "No valid recipients" };

  const cc = normalize(params.cc);
  const bcc = normalize(params.bcc);
  const fromEmail = params.fromEmail ?? env.RESEND_FROM_EMAIL ?? "rioko-devmode@kapta.pt";
  const fromName = params.fromName ?? "Rioko";
  const text = params.text ?? stripHtml(params.html);

  const wantResend = params.providerOverride === "resend"
    || (params.providerOverride !== "mailchannels" && !!env.RESEND_API_KEY);

  if (wantResend && env.RESEND_API_KEY) {
    try {
      const resend = new Resend(env.RESEND_API_KEY);
      const { data, error } = await resend.emails.send({
        from: `${fromName} <${fromEmail}>`,
        to,
        cc: cc.length ? cc : undefined,
        bcc: bcc.length ? bcc : undefined,
        subject: params.subject,
        html: params.html,
        text,
      });
      if (error) return { ok: false, provider: "resend", detail: error.message };
      return { ok: true, provider: "resend", id: data?.id };
    } catch (e: any) {
      console.warn(`[email] Resend failed, falling back to MailChannels: ${e?.message}`);
      // fall through to MailChannels
    }
  }

  return sendViaMailChannels({ to, cc, bcc, fromEmail, fromName, subject: params.subject, html: params.html, text });
}

async function sendViaMailChannels(p: {
  to: string[];
  cc: string[];
  bcc: string[];
  fromEmail: string;
  fromName: string;
  subject: string;
  html: string;
  text: string;
}): Promise<SendEmailResult> {
  const personalization: any = { to: p.to.map(email => ({ email })) };
  if (p.cc.length) personalization.cc = p.cc.map(email => ({ email }));
  if (p.bcc.length) personalization.bcc = p.bcc.map(email => ({ email }));

  const payload = {
    personalizations: [personalization],
    from: { email: p.fromEmail, name: p.fromName },
    subject: p.subject,
    content: [
      { type: "text/plain", value: p.text },
      { type: "text/html", value: p.html },
    ],
  };

  try {
    const res = await fetch("https://api.mailchannels.net/tx/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const detail = res.ok ? undefined : await res.text();
    return { ok: res.ok, provider: "mailchannels", status: res.status, detail };
  } catch (e) {
    return { ok: false, provider: "mailchannels", detail: String(e) };
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
