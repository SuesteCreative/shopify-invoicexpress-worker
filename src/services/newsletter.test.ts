import { describe, it, expect } from "vitest";
import { runNewsletterBroadcast, UNSUBSCRIBE_TAG, type ResendLike } from "./newsletter";
// Across the worker/backoffice boundary on purpose, and only in a test — the
// same trick connection-config-writable.test.ts uses. Nothing is imported at
// runtime; this asserts the two halves of one rule have not drifted apart.
import { requiredLegalOk } from "../../backoffice/src/lib/newsletter-template";

/**
 * What this guards is not an exception, it is a delivered email.
 *
 * The dangerous path is the second one: a contact Resend already knows. Adding
 * them to a segment is right; re-asserting `unsubscribed` or `topics` while
 * doing it would quietly walk back an opt-out, and the only person it happens to
 * is the one who asked us to stop.
 */

function fake() {
  const calls: { method: string; payload: any }[] = [];
  const existing = new Set<string>();
  const client: ResendLike = {
    segments: {
      async create(p) { calls.push({ method: "segments.create", payload: p }); return { data: { id: "seg_1" } }; },
    },
    contacts: {
      async create(p: any) {
        calls.push({ method: "contacts.create", payload: p });
        if (existing.has(p.email)) return { data: null, error: { message: "Contact already exists" } };
        return { data: { id: `con_${p.email}` } };
      },
      segments: {
        async add(p: any) { calls.push({ method: "contacts.segments.add", payload: p }); return { data: { id: "seg_1" } }; },
      },
    },
    broadcasts: {
      async create(p: any) { calls.push({ method: "broadcasts.create", payload: p }); return { data: { id: "bc_1" } }; },
      async send(id: string, p?: any) { calls.push({ method: "broadcasts.send", payload: { id, ...p } }); return { data: { id } }; },
    },
  };
  return { client, calls, existing };
}

const ENV: any = {
  RESEND_API_KEY: "re_test",
  RESEND_FROM_EMAIL: "noreply@rioko.online",
  RESEND_TOPIC_NEWS: "topic_news",
};

const HTML = `<p>Olá</p><a href="${UNSUBSCRIBE_TAG}">sair</a>`;

const base = (over: any = {}) => ({
  slug: "convite",
  subject: "Convide um amigo",
  html: HTML,
  recipients: [{ email: "a@x.pt", first_name: "Ana", user_id: "user_a", label: "Loja A" }],
  ...over,
});

describe("dry run", () => {
  it("touches Resend not at all", async () => {
    const f = fake();
    const r = await runNewsletterBroadcast(ENV, base({ client: f.client }));
    expect(f.calls).toHaveLength(0);
    expect(r.dry_run).toBe(true);
    expect(r.segment_id).toBeNull();
    expect(r.broadcast_id).toBeNull();
    expect(r.checked).toBe(1);
  });

  it("is the default, so forgetting the flag cannot send anything", async () => {
    const f = fake();
    const r = await runNewsletterBroadcast(ENV, base({ client: f.client, dryRun: undefined }));
    expect(r.dry_run).toBe(true);
    expect(f.calls).toHaveLength(0);
  });
});

describe("a real send", () => {
  it("makes one segment, one contact each, one broadcast, one send", async () => {
    const f = fake();
    const r = await runNewsletterBroadcast(ENV, base({
      client: f.client,
      dryRun: false,
      recipients: [
        { email: "a@x.pt", first_name: "Ana" },
        { email: "b@x.pt", first_name: "Rui" },
      ],
    }));

    expect(f.calls.map((c) => c.method)).toEqual([
      "segments.create",
      "contacts.create",
      "contacts.create",
      "broadcasts.create",
      "broadcasts.send",
    ]);
    expect(r.synced).toBe(2);
    expect(r.failed).toBe(0);
    expect(r.segment_id).toBe("seg_1");
    expect(r.broadcast_id).toBe("bc_1");

    const bc = f.calls.find((c) => c.method === "broadcasts.create")!.payload;
    expect(bc.segmentId).toBe("seg_1");
    expect(bc.topicId).toBe("topic_news");
    expect(bc.from).toBe("Rioko <noreply@rioko.online>");
    // The tag has to survive everything we do to the html, redaction included.
    expect(bc.html).toContain(UNSUBSCRIBE_TAG);
  });

  it("adds an existing contact to the segment without touching their opt-out", async () => {
    const f = fake();
    f.existing.add("old@x.pt");
    const r = await runNewsletterBroadcast(ENV, base({
      client: f.client,
      dryRun: false,
      recipients: [{ email: "old@x.pt", first_name: "Velho" }],
    }));

    expect(r.synced).toBe(1);
    const add = f.calls.find((c) => c.method === "contacts.segments.add");
    expect(add?.payload).toEqual({ email: "old@x.pt", segmentId: "seg_1" });
    // The whole point: nothing on the fallback path may carry these.
    expect(JSON.stringify(add?.payload)).not.toContain("unsubscribed");
    expect(JSON.stringify(add?.payload)).not.toContain("topics");
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
    expect(r.synced).toBe(1);
    expect(f.calls.filter((c) => c.method === "contacts.create")).toHaveLength(1);
  });

  it("passes a schedule through instead of sending now", async () => {
    const f = fake();
    await runNewsletterBroadcast(ENV, base({
      client: f.client, dryRun: false, scheduledAt: "2026-10-01T09:00:00.000Z",
    }));
    const send = f.calls.find((c) => c.method === "broadcasts.send")!;
    expect(send.payload).toEqual({ id: "bc_1", scheduledAt: "2026-10-01T09:00:00.000Z" });
  });
});

describe("refusals", () => {
  it("will not create anything for copy with no unsubscribe link", async () => {
    const f = fake();
    await expect(runNewsletterBroadcast(ENV, base({
      client: f.client, dryRun: false, html: "<p>sem saída</p>",
    }))).rejects.toThrow(/RESEND_UNSUBSCRIBE_URL/);
    expect(f.calls).toHaveLength(0);
  });

  it("will not send to an empty list", async () => {
    const f = fake();
    await expect(runNewsletterBroadcast(ENV, base({
      client: f.client, dryRun: false, recipients: [],
    }))).rejects.toThrow(/no valid recipients/);
    expect(f.calls).toHaveLength(0);
  });

  it("stops rather than mail a crowd by accident", async () => {
    const f = fake();
    const many = Array.from({ length: 2001 }, (_, i) => ({ email: `u${i}@x.pt` }));
    await expect(runNewsletterBroadcast(ENV, base({
      client: f.client, dryRun: false, recipients: many,
    }))).rejects.toThrow(/Too many recipients/);
    expect(f.calls).toHaveLength(0);
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
