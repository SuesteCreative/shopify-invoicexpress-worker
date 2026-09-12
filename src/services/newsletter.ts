import { Resend } from "resend";
import type { Env } from "../env";
import { redactSecrets } from "./redact";

/**
 * Sending a newsletter, through Resend Broadcasts.
 *
 * Why a Broadcast and not the send loop every other campaign in here uses: the
 * unsubscribe. A marketing email must carry a working opt-out and must honour it
 * for ever, and the only honest way to do that with our own loop is to own a
 * suppression list, which means a table, a route, a token, and a promise never
 * to get it wrong. Resend already owns one — `unsubscribed` is global to the
 * contact, `{{{RESEND_UNSUBSCRIBE_URL}}}` writes to it, and Broadcasts refuse to
 * deliver to it. We keep no opt-out of our own, so there is nothing to drift.
 *
 * The part that matters and is easy to miss: that flag suppresses BROADCASTS
 * ONLY. Transactional mail goes out through sendEmail() → POST /emails, which
 * never consults it. A merchant who cancels the newsletter still gets told their
 * invoicing is broken — which is exactly what the footer promises them, and what
 * migration 0046 promises the admin about a parked account.
 *
 * Segments here are containers, not saved filters: WE choose the audience, in
 * D1, in the backoffice, and hand the resolved list over. One segment per
 * campaign, kept afterwards, because it is the record of who a broadcast went to
 * and GET /broadcasts/{id}/recipients needs it.
 * ponytail: segments accumulate; prune by hand if the Resend account hits a cap.
 */

export interface NewsletterRecipient {
  email: string;
  first_name?: string | null;
  user_id?: string | null;
  label?: string | null;
}

export interface NewsletterCandidate {
  email: string;
  synced: boolean;
  created: boolean;
  error?: string;
}

export interface NewsletterResult {
  checked: number;
  synced: number;
  failed: number;
  skipped_invalid_email: number;
  segment_id: string | null;
  broadcast_id: string | null;
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
}

/** Only what this service uses, so a test can stand in for it honestly. */
export interface ResendLike {
  segments: { create(p: { name: string }): Promise<any> };
  contacts: {
    create(p: any): Promise<any>;
    segments: { add(p: any): Promise<any> };
  };
  broadcasts: {
    create(p: any): Promise<any>;
    send(id: string, p?: { scheduledAt?: string }): Promise<any>;
  };
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

/** A campaign can be large; a runaway loop against a paid API cannot. */
const MAX_RECIPIENTS = 2000;

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
    synced: 0,
    failed: 0,
    skipped_invalid_email: skipped,
    segment_id: null,
    broadcast_id: null,
    scheduled_at: opts.scheduledAt ?? null,
    dry_run: dryRun,
    candidates: valid.map((r) => ({ email: r.email, synced: false, created: false })),
  };

  // A dry run touches Resend not at all: no segment, no contact, no draft left
  // behind to be sent later by accident.
  if (dryRun) return result;
  if (!valid.length) throw new Error("Newsletter has no valid recipients");

  const resend = opts.client ?? (new Resend(env.RESEND_API_KEY) as unknown as ResendLike);

  const segment = await resend.segments.create({ name: `rioko-${opts.slug}-${stamp()}` });
  const segmentId = idOf(segment);
  if (!segmentId) throw new Error(`Resend did not return a segment id: ${JSON.stringify(segment)}`);
  result.segment_id = segmentId;

  const topicId = env.RESEND_TOPIC_NEWS?.trim() || undefined;

  for (let i = 0; i < valid.length; i++) {
    const r = valid[i];
    const card = result.candidates.find((c) => c.email === r.email)!;
    try {
      // First sight of an address: create it with the topic opted in, which is
      // what the merchant agreed to by registering.
      const created = await resend.contacts.create({
        email: r.email,
        firstName: r.first_name || undefined,
        properties: propertiesOf(r),
        segments: [{ id: segmentId }],
        ...(topicId ? { topics: [{ id: topicId, subscription: "opt_in" as const }] } : {}),
      });
      if (errorOf(created)) throw new Error(String(errorOf(created)));
      card.created = true;
      card.synced = true;
      result.synced++;
    } catch {
      // Already a contact. Add them to this campaign's segment and touch NOTHING
      // else — not `unsubscribed`, not `topics`. Re-asserting either would walk
      // an opt-out backwards, silently, for the one person who asked us to stop.
      try {
        const added = await resend.contacts.segments.add({ email: r.email, segmentId });
        if (errorOf(added)) throw new Error(String(errorOf(added)));
        card.synced = true;
        result.synced++;
      } catch (e: any) {
        card.error = e?.message ?? String(e);
        result.failed++;
      }
    }
  }

  if (result.synced === 0) throw new Error("No contact reached the segment; nothing was sent");

  // redactSecrets is applied inside sendEmail() for every other email we send. A
  // Broadcast does not go through it, so the net has to be re-hung here rather
  // than remembered by whoever writes the next template.
  const created = await resend.broadcasts.create({
    segmentId,
    from: `Rioko <${env.RESEND_FROM_EMAIL ?? "noreply@rioko.online"}>`,
    replyTo: "suporte@kapta.pt",
    subject: redactSecrets(opts.subject),
    html: redactSecrets(opts.html),
    name: `rioko-${opts.slug}-${stamp()}`,
    ...(opts.previewText ? { previewText: opts.previewText } : {}),
    ...(topicId ? { topicId } : {}),
  });
  const broadcastId = idOf(created);
  if (!broadcastId) throw new Error(`Resend did not return a broadcast id: ${JSON.stringify(created)}`);
  result.broadcast_id = broadcastId;

  const sent = await resend.broadcasts.send(
    broadcastId,
    opts.scheduledAt ? { scheduledAt: opts.scheduledAt } : undefined,
  );
  if (errorOf(sent)) throw new Error(`Broadcast ${broadcastId} was created but not sent: ${JSON.stringify(errorOf(sent))}`);

  return result;
}

/** Visible in Resend's own dashboard beside each contact, which is the only
 *  reason they exist: nothing here reads them back. */
function propertiesOf(r: NewsletterRecipient): Record<string, string> {
  const p: Record<string, string> = {};
  if (r.user_id) p.user_id = String(r.user_id).slice(0, 100);
  if (r.label) p.label = String(r.label).slice(0, 100);
  return p;
}

/** The SDK answers `{ data, error }`; older shapes answer the object directly. */
function idOf(res: any): string | null {
  return res?.data?.id ?? res?.id ?? null;
}
function errorOf(res: any): unknown {
  return res?.error ?? null;
}

/** YYYYMMDD, for a segment name a human can recognise in Resend's list. */
function stamp(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}
