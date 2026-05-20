import { sendEmail, type SendEmailResult } from "../services/email";
import type { Env } from "../env";

interface SendDevModeEmailParams {
  recipients: string[];
  subject: string;
  body: string;
  fromEmail?: string;
  fromName?: string;
  /** When provided, allows the sender to choose Resend over MailChannels. */
  env?: Env;
}

/**
 * Backward-compat wrapper around `sendEmail`. The pre-Phase-4 signature did not
 * accept `env`, so when called without it we send via MailChannels directly
 * (Resend needs an API key from env). All new code should pass `env`.
 */
export async function sendDevModeEmail(params: SendDevModeEmailParams): Promise<{ ok: boolean; status: number; detail?: string }> {
  const html = `<pre style="font-family:ui-monospace,Menlo,monospace;white-space:pre-wrap">${escapeHtml(params.body)}</pre>`;
  const result = await sendEmail(
    params.env ?? ({} as Env),
    {
      to: params.recipients,
      subject: params.subject,
      html,
      text: params.body,
      fromEmail: params.fromEmail,
      fromName: params.fromName ?? "Rioko Dev Mode",
    }
  );
  return toLegacyResult(result);
}

function toLegacyResult(r: SendEmailResult): { ok: boolean; status: number; detail?: string } {
  return {
    ok: r.ok,
    status: r.status ?? (r.ok ? 200 : 500),
    detail: r.detail,
  };
}

function escapeHtml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
