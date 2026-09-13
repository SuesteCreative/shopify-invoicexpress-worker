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
  /** The customer number (0058). Carried so a contact in Resend's own dashboard
   *  can be traced back to an account, not just to a mailbox. */
  client_code?: string | null;
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
  /** Test seam. Milliseconds between Resend calls; production uses RESEND_PACE_MS. */
  paceMs?: number;
}

/** Only what this service uses, so a test can stand in for it honestly. */
export interface ResendLike {
  segments: { create(p: { name: string }): Promise<any> };
  contacts: {
    get(p: { email: string }): Promise<any>;
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

/**
 * A campaign can be large; a runaway loop against a paid API cannot.
 * ponytail: the whole send runs inside one request, paced for Resend's rate
 * limit at two or three calls per recipient, so a few hundred recipients is the
 * practical ceiling long before this one. Move contact sync to a queue before an
 * audience gets there.
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
  // Resend allows ten requests a second for the whole team, transactional mail
  // included, and this loop makes two or three per recipient. Unpaced, the tail
  // of a list came back 429, was counted as failed, and the broadcast went out
  // to whoever happened to get in first.
  const call = paced(opts.paceMs ?? RESEND_PACE_MS);

  const segment = await call(() => resend.segments.create({ name: `rioko-${opts.slug}-${stamp()}` }));
  const segmentId = idOf(segment);
  if (!segmentId) throw new Error(`Resend: ${resendMessage(segment)}`);
  result.segment_id = segmentId;

  const topicId = env.RESEND_TOPIC_NEWS?.trim() || undefined;

  for (let i = 0; i < valid.length; i++) {
    const r = valid[i];
    const card = result.candidates.find((c) => c.email === r.email)!;

    // All an existing contact ever gets: this campaign's segment. NOTHING else —
    // not `unsubscribed`, not `topics`. Re-asserting either would walk an opt-out
    // backwards, silently, for the one person who asked us to stop.
    const addToSegment = async () => {
      const added = await call(() => resend.contacts.segments.add({ email: r.email, segmentId }));
      if (errorOf(added)) throw new Error(messageOf(errorOf(added)));
    };

    try {
      // Look before creating. Whether POST /contacts on an address Resend already
      // knows fails or quietly updates it is not documented, and an update would
      // put the topic back to opt_in for somebody who left it.
      const found = await call(() => resend.contacts.get({ email: r.email }));
      if (idOf(found)) {
        await addToSegment();
      } else if (isNotFound(errorOf(found))) {
        // First sight of an address: created with the topic opted in, which is
        // what the merchant agreed to by registering.
        const contact = {
          email: r.email,
          firstName: r.first_name || undefined,
          segments: [{ id: segmentId }],
          ...(topicId ? { topics: [{ id: topicId, subscription: "opt_in" as const }] } : {}),
        };
        let made = await call(() => resend.contacts.create({ ...contact, properties: propertiesOf(r) }));
        // A property key missing from Audience → Properties fails the whole
        // create, and none existed before the first send. The properties only
        // trace a contact back to an account in Resend's dashboard; the email is
        // the point, so it goes without them rather than not at all.
        if (errorOf(made)) made = await call(() => resend.contacts.create(contact));
        if (errorOf(made)) {
          // Created by somebody else between the look and now: still only the segment.
          const why = messageOf(errorOf(made));
          await addToSegment().catch((e: any) => { throw new Error(`${why}; ${e?.message ?? e}`); });
        } else {
          card.created = true;
        }
      } else {
        // Neither there nor missing. With no way to tell whether this address
        // opted out, it is neither created nor mailed.
        throw new Error(messageOf(errorOf(found)));
      }
      card.synced = true;
      result.synced++;
    } catch (e: any) {
      card.error = e?.message ?? String(e);
      result.failed++;
    }
  }

  if (result.synced === 0) {
    // The first candidate's reason leads: a whole list failing the same way (a
    // plan limit, a key without contacts access) is the usual shape of this.
    const why = result.candidates.find((c) => c.error)?.error;
    throw new Error(`No contact reached the segment, nothing was sent${why ? `: ${why}` : ""}`);
  }

  // redactSecrets is applied inside sendEmail() for every other email we send. A
  // Broadcast does not go through it, so the net has to be re-hung here rather
  // than remembered by whoever writes the next template.
  const created = await call(() => resend.broadcasts.create({
    segmentId,
    from: `Rioko <${env.RESEND_FROM_EMAIL ?? "noreply@rioko.online"}>`,
    replyTo: "suporte@kapta.pt",
    subject: redactSecrets(opts.subject),
    html: redactSecrets(opts.html),
    name: `rioko-${opts.slug}-${stamp()}`,
    ...(opts.previewText ? { previewText: opts.previewText } : {}),
    ...(topicId ? { topicId } : {}),
  }));
  const broadcastId = idOf(created);
  if (!broadcastId) throw new Error(`Resend: ${resendMessage(created)}`);
  result.broadcast_id = broadcastId;

  const sent = await call(() => resend.broadcasts.send(
    broadcastId,
    opts.scheduledAt ? { scheduledAt: opts.scheduledAt } : undefined,
  ));
  if (errorOf(sent)) throw new Error(`Resend created broadcast ${broadcastId} but did not send it: ${resendMessage(sent)}`);

  return result;
}

/** What Resend said, and only that. The SDK's answer also carries every HTTP
 *  header, and stringifying it buried the one readable line in a wall of JSON. */
function resendMessage(res: any): string {
  const err = errorOf(res);
  return err ? messageOf(err) : "no id in the response";
}

/** Visible in Resend's own dashboard beside each contact, which is the only
 *  reason they exist: nothing here reads them back. */
function propertiesOf(r: NewsletterRecipient): Record<string, string> {
  const p: Record<string, string> = {};
  if (r.user_id) p.user_id = String(r.user_id).slice(0, 100);
  if (r.label) p.label = String(r.label).slice(0, 100);
  if (r.client_code) p.client_code = String(r.client_code).slice(0, 100);
  return p;
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

function isNotFound(err: any): boolean {
  return Boolean(err) && (err.statusCode === 404 || err.name === "not_found");
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

/** YYYYMMDD, for a segment name a human can recognise in Resend's list. */
function stamp(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}
