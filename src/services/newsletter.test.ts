import { describe, it, expect } from "vitest";
import { runNewsletterBroadcast, personalise, unsubscribeToken, UNSUBSCRIBE_TAG, type ResendLike } from "./newsletter";
// Across the worker/backoffice boundary on purpose, and only in a test — the
// same trick connection-config-writable.test.ts uses. Nothing is imported at
// runtime; these assert the two halves of one rule have not drifted apart.
import { requiredLegalOk } from "../../backoffice/src/lib/newsletter-template";
import { verifyUnsubscribeToken } from "../../backoffice/src/lib/newsletter-unsubscribe";

/**
 * What this guards is not an exception, it is a delivered email: one per person,
 * greeted by their own name, carrying a way out that works for that address and
 * no other.
 */

function fake() {
  const sent: any[] = [];
  /** Addresses Resend refuses. */
  const refuse = new Set<string>();
  /** Addresses whose next send answers 429 once. */
  const rateLimitOnce = new Set<string>();
  const client: ResendLike = {
    emails: {
      async send(p: any) {
        if (rateLimitOnce.delete(p.to)) {
          return { data: null, error: { statusCode: 429, name: "rate_limit_exceeded", message: "Too many requests" } };
        }
        if (refuse.has(p.to)) {
          return { data: null, error: { statusCode: 422, name: "validation_error", message: "You can only send 100 emails per day" } };
        }
        sent.push(p);
        return { data: { id: `em_${sent.length}` } };
      },
    },
  };
  return { client, sent, refuse, rateLimitOnce };
}

const ENV: any = {
  RESEND_API_KEY: "re_test",
  RESEND_FROM_EMAIL: "noreply@rioko.online",
  ADMIN_API_KEY: "admin_key_for_tests",
};

const HTML = `<html><body><p>Olá {{{contact.first_name|}}},</p><a href="${UNSUBSCRIBE_TAG}">sair</a></body></html>`;

const base = (over: any = {}) => ({
  slug: "convite",
  subject: "Convide um amigo",
  html: HTML,
  recipients: [{ email: "a@x.pt", first_name: "Ana", user_id: "user_a", label: "Loja A" }],
  paceMs: 0,
  ...over,
});

const hrefOf = (html: string) => html.match(/href="([^"]+)"/)![1];

describe("dry run", () => {
  it("touches Resend not at all", async () => {
    const f = fake();
    const r = await runNewsletterBroadcast(ENV, base({ client: f.client }));
    expect(r.dry_run).toBe(true);
    expect(r.candidates).toHaveLength(1);
    expect(f.sent).toHaveLength(0);
  });

  it("is the default, so forgetting the flag cannot send anything", async () => {
    const f = fake();
    const r = await runNewsletterBroadcast(ENV, base({ client: f.client, dryRun: undefined }));
    expect(r.dry_run).toBe(true);
    expect(f.sent).toHaveLength(0);
  });
});

describe("a real send", () => {
  it("sends one email per recipient, greeted by name, from Rioko with replies to support", async () => {
    const f = fake();
    const r = await runNewsletterBroadcast(ENV, base({
      client: f.client,
      dryRun: false,
      recipients: [
        { email: "a@x.pt", first_name: "Ana" },
        { email: "b@x.pt", first_name: "Bruno" },
      ],
    }));
    expect(r.sent).toBe(2);
    expect(r.failed).toBe(0);
    expect(f.sent.map((e) => e.to)).toEqual(["a@x.pt", "b@x.pt"]);
    expect(f.sent[0]).toMatchObject({ from: "Rioko <noreply@rioko.online>", replyTo: "suporte@kapta.pt" });
    expect(f.sent[0].html).toContain("<p>Olá Ana,</p>");
    expect(f.sent[1].html).toContain("<p>Olá Bruno,</p>");
    expect(r.candidates[1]).toMatchObject({ email: "b@x.pt", sent: true, id: "em_2" });
  });

  it("gives each address its own unsubscribe link, one the backoffice accepts for that address only", async () => {
    const f = fake();
    await runNewsletterBroadcast(ENV, base({
      client: f.client,
      dryRun: false,
      recipients: [{ email: "a@x.pt" }, { email: "b@x.pt" }],
    }));
    const links = f.sent.map((e) => hrefOf(e.html));
    expect(links[0]).not.toBe(links[1]);
    expect(links[0]).toMatch(/^https:\/\/rioko\.online\/api\/newsletter\/unsubscribe\?t=/);
    for (const [i, email] of ["a@x.pt", "b@x.pt"].entries()) {
      const token = new URL(links[i]).searchParams.get("t")!;
      expect(await verifyUnsubscribeToken(ENV.ADMIN_API_KEY, token)).toBe(email);
      expect(await verifyUnsubscribeToken("another key", token)).toBeNull();
      // The inbox's own button points at the same place, and says it takes one click.
      expect(f.sent[i].headers).toEqual({
        "List-Unsubscribe": `<${links[i]}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      });
    }
    expect(f.sent.some((e) => e.html.includes(UNSUBSCRIBE_TAG))).toBe(false);
  });

  it("refuses a token whose address was swapped", async () => {
    const good = await unsubscribeToken(ENV.ADMIN_API_KEY, "a@x.pt");
    const forged = `${btoa("b@x.pt").replace(/=+$/, "")}.${good.split(".")[1]}`;
    expect(await verifyUnsubscribeToken(ENV.ADMIN_API_KEY, forged)).toBeNull();
    expect(await verifyUnsubscribeToken(ENV.ADMIN_API_KEY, "nonsense")).toBeNull();
  });

  it("puts the inbox preview line first in the body", async () => {
    const f = fake();
    await runNewsletterBroadcast(ENV, base({ client: f.client, dryRun: false, previewText: "Dois meses <grátis>" }));
    expect(f.sent[0].html).toMatch(/^<html><body><div style="display:none[^"]*">Dois meses &lt;grátis&gt;<\/div><p>/);
  });

  it("passes a schedule through to every email", async () => {
    const f = fake();
    await runNewsletterBroadcast(ENV, base({
      client: f.client, dryRun: false, scheduledAt: "2026-10-01T09:00:00.000Z",
    }));
    expect(f.sent[0].scheduledAt).toBe("2026-10-01T09:00:00.000Z");
  });

  it("waits out a rate limit instead of counting the recipient as failed", async () => {
    const f = fake();
    f.rateLimitOnce.add("a@x.pt");
    const r = await runNewsletterBroadcast(ENV, base({ client: f.client, dryRun: false }));
    expect(r.sent).toBe(1);
    expect(r.failed).toBe(0);
  });

  it("counts a refused address and still sends to the rest", async () => {
    const f = fake();
    f.refuse.add("b@x.pt");
    const r = await runNewsletterBroadcast(ENV, base({
      client: f.client,
      dryRun: false,
      recipients: [{ email: "a@x.pt" }, { email: "b@x.pt" }],
    }));
    expect(r.sent).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.candidates[1].error).toBe("Resend: You can only send 100 emails per day");
  });

  it("says what Resend said when nothing at all went out", async () => {
    const f = fake();
    f.refuse.add("a@x.pt");
    const e = await runNewsletterBroadcast(ENV, base({ client: f.client, dryRun: false })).catch((x) => x);
    expect(e.message).toBe("Nothing was sent: Resend: You can only send 100 emails per day");
  });

  it("drops invalid and duplicate addresses before sending", async () => {
    const f = fake();
    const r = await runNewsletterBroadcast(ENV, base({
      client: f.client,
      dryRun: false,
      recipients: [
        { email: "a@x.pt" },
        { email: "A@X.pt" },      // same person, different case
        { email: "not-an-email" },
        { email: "" },
      ],
    }));
    expect(r.skipped_invalid_email).toBe(2);
    expect(r.sent).toBe(1);
    expect(f.sent).toHaveLength(1);
  });
});

describe("personalise", () => {
  const link = "https://rioko.online/api/newsletter/unsubscribe?t=x.y";

  it("greets by name, falls back, and collapses cleanly with neither", () => {
    const text = "Olá {{{contact.first_name|}}}, ou {{{contact.first_name|amigo}}}";
    expect(personalise(text, { email: "a@x.pt", first_name: "Ana" }, link)).toBe("Olá Ana, ou Ana");
    expect(personalise(text, { email: "a@x.pt", first_name: "" }, link)).toBe("Olá, ou amigo");
  });

  it("leaves every other triple alone", () => {
    expect(personalise("{{{contact.company|}}}", { email: "a@x.pt" }, link)).toBe("{{{contact.company|}}}");
  });
});

describe("refusals", () => {
  it("will not send copy with no unsubscribe link", async () => {
    const f = fake();
    await expect(runNewsletterBroadcast(ENV, base({
      client: f.client, dryRun: false, html: "<p>sem saída</p>",
    }))).rejects.toThrow(/RESEND_UNSUBSCRIBE_URL/);
    expect(f.sent).toHaveLength(0);
  });

  it("will not send when there is no key to sign the way out with", async () => {
    const f = fake();
    await expect(runNewsletterBroadcast({ ...ENV, ADMIN_API_KEY: "" }, base({
      client: f.client, dryRun: false,
    }))).rejects.toThrow(/ADMIN_API_KEY/);
    expect(f.sent).toHaveLength(0);
  });

  it("will not send to an empty list", async () => {
    const f = fake();
    await expect(runNewsletterBroadcast(ENV, base({
      client: f.client, dryRun: false, recipients: [],
    }))).rejects.toThrow(/no valid recipients/);
    expect(f.sent).toHaveLength(0);
  });

  it("stops rather than mail a crowd by accident", async () => {
    const f = fake();
    const many = Array.from({ length: 2001 }, (_, i) => ({ email: `u${i}@x.pt` }));
    await expect(runNewsletterBroadcast(ENV, base({
      client: f.client, dryRun: false, recipients: many,
    }))).rejects.toThrow(/Too many recipients/);
    expect(f.sent).toHaveLength(0);
  });
});

describe("the two halves of the legal gate agree", () => {
  it("demands the same tag on both sides of the boundary", () => {
    // The backoffice states the full rule to the operator; the worker guards the
    // one part of it that cannot be repaired after delivery. If someone renames
    // the tag on one side, this fails instead of the unsubscribe link.
    const lawful = `${UNSUBSCRIBE_TAG} ABSOLUTEPIXEL UNIPESSOAL, LDA 516277421 https://rioko.online/pt/privacy`;
    expect(requiredLegalOk(lawful)).toBeNull();
    expect(requiredLegalOk(lawful.replace(UNSUBSCRIBE_TAG, ""))).toMatch(/cancelamento/);
  });
});
