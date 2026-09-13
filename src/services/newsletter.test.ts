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
  /** Custom property keys Resend knows. Empty, as it was before the first send. */
  const properties = new Set<string>();
  /** Addresses whose next `get` answers 429 once. */
  const rateLimitOnce = new Set<string>();
  /** Addresses whose `get` fails with something that is not "not found". */
  const brokenGet = new Set<string>();
  const client: ResendLike = {
    segments: {
      async create(p) { calls.push({ method: "segments.create", payload: p }); return { data: { id: "seg_1" } }; },
    },
    contacts: {
      async get(p: any) {
        calls.push({ method: "contacts.get", payload: p });
        if (rateLimitOnce.delete(p.email)) {
          return { data: null, error: { statusCode: 429, name: "rate_limit_exceeded", message: "Too many requests" } };
        }
        if (brokenGet.has(p.email)) return { data: null, error: { statusCode: 500, name: "application_error", message: "boom" } };
        if (existing.has(p.email)) return { data: { id: `con_${p.email}` } };
        return { data: null, error: { statusCode: 404, name: "not_found", message: "Contact not found" } };
      },
      async create(p: any) {
        calls.push({ method: "contacts.create", payload: p });
        if (existing.has(p.email)) return { data: null, error: { message: "Contact already exists" } };
        const unknown = Object.keys(p.properties ?? {}).filter((k) => !properties.has(k));
        if (unknown.length) return { data: null, error: { statusCode: 422, name: "validation_error", message: `Property ${unknown[0]} does not exist` } };
        existing.add(p.email);
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
  return { client, calls, existing, properties, rateLimitOnce, brokenGet };
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
  paceMs: 0,
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
  it("makes one segment, looks each contact up, creates the new ones, one broadcast, one send", async () => {
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
      "contacts.get",
      "contacts.create",
      "contacts.get",
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

  it("only adds an existing contact to the segment, and never creates it again", async () => {
    const f = fake();
    f.existing.add("old@x.pt");
    const r = await runNewsletterBroadcast(ENV, base({
      client: f.client,
      dryRun: false,
      recipients: [{ email: "old@x.pt", first_name: "Velho" }],
    }));

    expect(r.synced).toBe(1);
    // A create on a known address might update it, topic included. It never happens.
    expect(f.calls.filter((c) => c.method === "contacts.create")).toHaveLength(0);
    const add = f.calls.find((c) => c.method === "contacts.segments.add");
    expect(add?.payload).toEqual({ email: "old@x.pt", segmentId: "seg_1" });
    // The whole point: nothing on this path may carry these.
    expect(JSON.stringify(add?.payload)).not.toContain("unsubscribed");
    expect(JSON.stringify(add?.payload)).not.toContain("topics");
  });

  it("still creates the contact, without properties, when Resend does not know them", async () => {
    // Before the first send no custom property exists in Resend, and a create
    // that names one fails outright. Every contact failed with it, and the
    // broadcast aborted with nobody in the segment.
    const f = fake();
    const r = await runNewsletterBroadcast(ENV, base({
      client: f.client,
      dryRun: false,
      recipients: [{ email: "a@x.pt", first_name: "Ana", user_id: "user_a", label: "Loja A", client_code: "RIO-1A2B3C" }],
    }));

    expect(r.synced).toBe(1);
    expect(r.candidates[0].created).toBe(true);
    const creates = f.calls.filter((c) => c.method === "contacts.create").map((c) => c.payload);
    expect(creates).toHaveLength(2);
    expect(creates[0].properties).toEqual({ user_id: "user_a", label: "Loja A", client_code: "RIO-1A2B3C" });
    expect(creates[1].properties).toBeUndefined();
    // The topic and the segment are not what failed, so they stay.
    expect(creates[1].topics).toEqual([{ id: "topic_news", subscription: "opt_in" }]);
    expect(creates[1].segments).toEqual([{ id: "seg_1" }]);
  });

  it("sends the properties when Resend has them", async () => {
    const f = fake();
    ["user_id", "label", "client_code"].forEach((k) => f.properties.add(k));
    await runNewsletterBroadcast(ENV, base({ client: f.client, dryRun: false }));
    const creates = f.calls.filter((c) => c.method === "contacts.create");
    expect(creates).toHaveLength(1);
    expect(creates[0].payload.properties).toEqual({ user_id: "user_a", label: "Loja A" });
  });

  it("neither creates nor mails an address it could not look up", async () => {
    // Not "missing", not "there": it may be somebody who opted out.
    const f = fake();
    f.brokenGet.add("b@x.pt");
    const r = await runNewsletterBroadcast(ENV, base({
      client: f.client,
      dryRun: false,
      recipients: [{ email: "a@x.pt" }, { email: "b@x.pt" }],
    }));
    expect(r.synced).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.candidates.find((c) => c.email === "b@x.pt")?.error).toBe("boom");
    expect(f.calls.some((c) => c.method !== "contacts.get" && c.payload?.email === "b@x.pt")).toBe(false);
  });

  it("waits out a rate limit instead of counting the recipient as failed", async () => {
    const f = fake();
    f.rateLimitOnce.add("a@x.pt");
    const r = await runNewsletterBroadcast(ENV, base({ client: f.client, dryRun: false }));
    expect(r.synced).toBe(1);
    expect(r.failed).toBe(0);
    expect(f.calls.filter((c) => c.method === "contacts.get")).toHaveLength(2);
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

  it("says what Resend said when it refuses the segment, and nothing else", async () => {
    // The real refusal from 13/09, headers and all: stringified whole, the one
    // readable line was buried, and the panel never showed it at all.
    const f = fake();
    f.client.segments.create = async () => ({
      data: null,
      error: { statusCode: 400, name: "validation_error", message: "Your plan includes 3 segments. Upgrade to add more." },
      headers: { "cf-ray": "a3a8356a7c6ecfbd-MAD", "content-type": "application/json" },
    });
    const e = await runNewsletterBroadcast(ENV, base({ client: f.client, dryRun: false })).catch((x) => x);
    expect(e.message).toBe("Resend: Your plan includes 3 segments. Upgrade to add more.");
  });

  it("names the first recipient's reason when nobody reached the segment", async () => {
    const f = fake();
    f.brokenGet.add("a@x.pt");
    const e = await runNewsletterBroadcast(ENV, base({ client: f.client, dryRun: false })).catch((x) => x);
    expect(e.message).toBe("No contact reached the segment, nothing was sent: boom");
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
