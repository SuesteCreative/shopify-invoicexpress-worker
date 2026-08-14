/**
 * Lodgify feeder — the ingestion half of Lodgify → Moloni, exiled to Vercel.
 *
 * Lodgify blocks the Cloudflare Worker's egress (an unregistered integrator
 * pulling several end users' data from one IP → lodgify.com/partners). The
 * booking list is therefore fetched from here and posted back to the Worker,
 * which still owns every fiscal decision: normalization, the settlement gate,
 * the cutoff, dedup and emission. This file must stay dumb on purpose.
 *
 * Per tenant, per run:
 *   1. list bookings from Lodgify v1
 *   2. POST them with dry_run → mirror refreshed, nothing billed, Worker
 *      answers with the handful it WOULD bill
 *   3. fetch the v1 detail for just those (address + the NIF note)
 *   4. POST again for real
 *
 * This is temporary scaffolding. When partner registration lands, the Worker
 * polls Lodgify directly again and this project gets deleted.
 */

import { listBookings, getBookingDetail, probe, LodgifyBlockedError } from "../lib/lodgify.js";
import { mergeDetailIntoItem } from "../lib/merge.js";

const RUN_BUDGET_MS = 240_000;   // leave headroom under maxDuration: 300
const MAX_ENRICH_PER_TENANT = 25;
const TENANT_GAP_MS = 2_000;
const ENRICH_GAP_MS = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function workerUrl(path) {
  const base = (process.env.WORKER_URL || "").replace(/\/$/, "");
  if (!base) throw new Error("WORKER_URL is not set");
  return `${base}${path}`;
}

async function callWorker(path, { method = "POST", body } = {}) {
  const res = await fetch(workerUrl(path), {
    method,
    headers: {
      "x-api-key": process.env.ADMIN_API_KEY || "",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep text for the error */ }
  if (!res.ok) throw new Error(`Worker ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return json ?? {};
}

/** Tell the Worker ingestion failed, so it raises the same incident it would raise itself. */
async function reportFeedError(userId, message) {
  try {
    await callWorker("/admin/lodgify/feed-error", { body: { user_id: userId, error: message } });
  } catch (e) {
    // The Worker being unreachable is itself the outage; Vercel's cron-failure
    // notification is the second channel, and it fires on the non-200 below.
    console.error(`[feeder] could not report error for ${userId}: ${e.message}`);
  }
}

async function runTenant(tenant, { dry, deadline }) {
  const out = { user_id: tenant.user_id, pages: 0, bookings: 0, synced: 0, would_invoice: 0, invoiced: 0, skipped: 0, failed: 0, enriched: 0 };

  // A connection with no cutoff would have its ENTIRE history billed, dated
  // today, by the very first real run. That is a human decision (see the
  // backfill route), never a side effect of switching the feeder on.
  if (!tenant.has_cutoff) {
    out.error = "no invoice_cutoff on the connection — refusing to bill";
    await reportFeedError(tenant.user_id, "Feeder recusou-se a facturar: ligação Lodgify sem invoice_cutoff definido.");
    return out;
  }

  const { bookings, pages } = await listBookings(tenant.api_key);
  out.pages = pages;
  out.bookings = bookings.length;

  // Nothing to post. Deliberately NOT an empty POST: `bookings: []` reads as
  // "this account has no bookings" and would mirror nothing while looking fine.
  if (bookings.length === 0) return out;

  const dryRes = await callWorker("/admin/lodgify/poll", {
    body: { user_id: tenant.user_id, bookings, dry_run: true },
  });
  out.synced = dryRes.synced ?? 0;
  const would = Array.isArray(dryRes.wouldInvoice) ? dryRes.wouldInvoice : [];
  out.would_invoice = would.length;

  if (dry || would.length === 0) return out;

  // Enrich only what is about to become a document. Enriching everything would
  // be thousands of requests a day from one IP serving several accounts — the
  // exact behaviour that got this integration blocked in the first place.
  const wanted = new Set(would.slice(0, MAX_ENRICH_PER_TENANT).map((w) => String(w.booking_id)));
  const enriched = [];
  for (const item of bookings) {
    const id = String(item?.id ?? "");
    if (!wanted.has(id) || Date.now() > deadline) { enriched.push(item); continue; }
    let detail = null;
    try {
      detail = await getBookingDetail(tenant.api_key, id);
    } catch (e) {
      if (e instanceof LodgifyBlockedError) throw e;
      console.warn(`[feeder] detail ${id} failed: ${e.message}`);
    }
    if (detail) out.enriched++;
    enriched.push(mergeDetailIntoItem(item, detail));
    await sleep(ENRICH_GAP_MS);
  }

  const realRes = await callWorker("/admin/lodgify/poll", {
    body: { user_id: tenant.user_id, bookings: enriched },
  });
  out.invoiced = realRes.invoiced ?? 0;
  out.skipped = realRes.skipped ?? 0;
  out.failed = realRes.failed ?? 0;
  return out;
}

export default async function handler(req, res) {
  // Vercel signs cron invocations with CRON_SECRET. Without this check the
  // endpoint is a public "invoice everyone now" button.
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || "";
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const url = new URL(req.url, "http://localhost");
  const only = url.searchParams.get("tenant");
  const dry = url.searchParams.get("dry") === "1";
  const mode = url.searchParams.get("mode");
  const deadline = Date.now() + RUN_BUDGET_MS;

  // The kill switch stops the feeder from acting, not from being questioned.
  // `mode=diag` is a read-only reachability probe, and the moment you most want
  // it is while the feeder is still switched off.
  if (process.env.FEED_ENABLED === "0" && mode !== "diag") {
    return res.status(200).json({ skipped: "FEED_ENABLED=0" });
  }

  let manifest;
  try {
    manifest = await callWorker("/admin/lodgify/feed-manifest", { method: "GET" });
  } catch (e) {
    return res.status(500).json({ error: `manifest failed: ${e.message}` });
  }
  const tenants = (manifest.tenants ?? []).filter((t) => !only || t.user_id === only);

  // Reachability probe: is THIS egress able to talk to Lodgify for this key?
  // The only honest way to know, and it doubles as the API-key validation the
  // onboarding wizard never does.
  if (mode === "diag") {
    const diags = [];
    for (const t of tenants) {
      try { diags.push({ user_id: t.user_id, ...(await probe(t.api_key)) }); }
      catch (e) { diags.push({ user_id: t.user_id, error: e.message }); }
    }
    return res.status(200).json({ mode: "diag", tenants: diags });
  }

  const results = [];
  let hadFailure = false;
  for (const tenant of tenants) {
    if (Date.now() > deadline) {
      results.push({ user_id: tenant.user_id, skipped: "run budget exhausted" });
      continue;
    }
    try {
      results.push(await runTenant(tenant, { dry, deadline }));
    } catch (e) {
      hadFailure = true;
      const msg = e instanceof LodgifyBlockedError
        ? e.message
        : `${e.name === "TimeoutError" ? "timeout" : "error"}: ${e.message}`;
      console.error(`[feeder] tenant ${tenant.user_id} failed: ${msg}`);
      await reportFeedError(tenant.user_id, msg);
      results.push({ user_id: tenant.user_id, error: msg });
    }
    // One tenant's failure must never cost the others their run.
    await sleep(TENANT_GAP_MS);
  }

  // Non-200 on any failure so Vercel's own cron-failure notification fires —
  // a channel that survives the Worker being down.
  return res.status(hadFailure ? 500 : 200).json({ ranAt: new Date().toISOString(), dry, results });
}
