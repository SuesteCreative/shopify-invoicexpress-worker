interface SendEmailParams {
  recipients: string[];
  subject: string;
  body: string;
  fromEmail?: string;
  fromName?: string;
}

export async function sendDevModeEmail(params: SendEmailParams): Promise<{ ok: boolean; status: number; detail?: string }> {
  const valid = params.recipients.filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  if (valid.length === 0) return { ok: false, status: 400, detail: "No valid recipients" };

  const payload = {
    personalizations: valid.map(email => ({ to: [{ email }] })),
    from: {
      email: params.fromEmail ?? "rioko-devmode@kapta.pt",
      name: params.fromName ?? "Rioko Dev Mode",
    },
    subject: params.subject,
    content: [
      { type: "text/plain", value: params.body },
      { type: "text/html", value: `<pre style="font-family:ui-monospace,Menlo,monospace;white-space:pre-wrap">${escapeHtml(params.body)}</pre>` },
    ],
  };

  try {
    const res = await fetch("https://api.mailchannels.net/tx/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const detail = res.ok ? undefined : await res.text();
    return { ok: res.ok, status: res.status, detail };
  } catch (e) {
    return { ok: false, status: 500, detail: String(e) };
  }
}

function escapeHtml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
