import { describe, it, expect, vi, afterEach } from "vitest";
import { sendEmail } from "./email";

/**
 * The last gate before text leaves the building.
 *
 * Every alert we send is assembled from destination error strings, and
 * InvoiceXpress accepts its credential ONLY as `?api_key=` — verified against
 * the live API on 2026-09-02, where Authorization, X-Api-Key and Api-Key all
 * answer 401. So the key is in the URL of every failing request by construction,
 * and there is no upstream fix available to us: the only defence is to redact
 * what we store and what we send.
 *
 * Redacting in `sendEmail` rather than in each template is the point. Templates
 * get added; this does not have to be remembered.
 */

const KEY = "d795a623e8f04c11bd77";
const BODY = `<p>Request timed out: GET https://acct.app.invoicexpress.com/invoices/268954123.json?api_key=${KEY}</p>`;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("sendEmail", () => {
  it("never lets a credential reach the provider — subject, html or text", async () => {
    const sent: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: any, init: any) => {
      sent.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response("", { status: 202 });
    }));

    const res = await sendEmail({ RESEND_API_KEY: "" } as any, {
      to: "ops@example.com",
      subject: `Falha na conta acct (api_key=${KEY})`,
      html: BODY,
    });

    expect(res.ok).toBe(true);
    const payload = JSON.stringify(sent[0]);
    expect(payload).not.toContain(KEY);
    // The operator still gets everything they need to act on.
    expect(payload).toContain("268954123");
    expect(payload).toContain("Request timed out");
  });

  it("redacts the plain-text part too, which is derived from the html", async () => {
    // `text` defaults to a stripped copy of `html`, so redacting only one of the
    // two would send the key anyway, in the half nobody looks at.
    const sent: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: any, init: any) => {
      sent.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response("", { status: 202 });
    }));

    await sendEmail({ RESEND_API_KEY: "" } as any, {
      to: "ops@example.com", subject: "Falha", html: BODY,
    });

    const contents = sent[0].content.map((c: any) => c.value).join("\n");
    expect(contents).not.toContain(KEY);
    expect(contents).toContain("api_key=«redacted»");
  });

  it("leaves an ordinary alert untouched", async () => {
    const sent: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: any, init: any) => {
      sent.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response("", { status: 202 });
    }));

    const html = "<p>Factura 268954123 emitida para a encomenda #ZL5366 por 51,00 €</p>";
    await sendEmail({ RESEND_API_KEY: "" } as any, { to: "ops@example.com", subject: "Tudo bem", html });

    expect(sent[0].content.find((c: any) => c.type === "text/html").value).toBe(html);
    expect(sent[0].subject).toBe("Tudo bem");
  });
});
