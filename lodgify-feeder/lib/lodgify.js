/**
 * The Lodgify half of the feeder: a deliberate port of `listLodgifyBookings`
 * from the Worker (src/index.ts), including its two hard invariants. Kept as a
 * port rather than a shared module because it runs on a different platform with
 * a different deploy cycle; if you change one, change both.
 *
 * Nothing here normalizes, filters or judges a booking — raw v1 items go to the
 * Worker exactly as Lodgify returned them, so a single normalizer (and a single
 * set of fiscal rules) exists in exactly one place.
 */

const LODGIFY_API = "https://api.lodgify.com";
const PAGE_SIZE = 50;
const MAX_PAGES = 40;

export class LodgifyBlockedError extends Error {
  constructor(body) {
    super(`LODGIFY_IP_BLOCKED: ${String(body).slice(0, 300)}`);
    this.name = "LodgifyBlockedError";
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function headersFor(apiKey) {
  return {
    "X-ApiKey": apiKey,
    Accept: "application/json",
    // Say who we are. If Lodgify looks at why this IP is pulling several
    // accounts, the answer should be reachable from the request itself.
    "User-Agent": process.env.FEED_USER_AGENT || "Rioko/1.0 (+https://rioko.online; partner application pending)",
  };
}

/**
 * Every booking on the account, oldest page first.
 *
 * Throws instead of returning a short list. A partial list is worse than no
 * list: the Worker would mirror it as the truth, and a booking missing from the
 * truth is a booking nobody bills and nobody misses.
 */
export async function listBookings(apiKey) {
  const out = [];
  let pages = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${LODGIFY_API}/v1/reservation?offset=${page * PAGE_SIZE}&limit=${PAGE_SIZE}&trash=False`;
    let items = null;
    let lastFailure = "";

    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(url, { headers: headersFor(apiKey), signal: AbortSignal.timeout(20_000) });

      if (res.ok) {
        const raw = await res.text();
        let data = null;
        try { data = JSON.parse(raw); } catch { /* handled below */ }
        if (data == null) {
          // A 200 whose body isn't JSON is a WAF challenge or an outage page,
          // NOT "this account has no bookings".
          lastFailure = `200 with unparseable body: ${raw.slice(0, 120)}`;
          break;
        }
        items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
        break;
      }

      lastFailure = `${res.status} ${res.statusText}`;
      if (res.status === 429) {
        // 429 covers both a transient rate limit and the permanent partner
        // block. The second needs registration, not patience — never retry it.
        const body = await res.text().catch(() => "");
        if (/unregistered API user|lodgify\.com\/partners|has been blocked/i.test(body)) {
          throw new LodgifyBlockedError(body);
        }
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 6000) : 700 * (attempt + 1));
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(`Lodgify rejected the API key: ${res.status} ${res.statusText}`);
      }
      break;
    }

    if (items == null) {
      throw new Error(`Lodgify v1 list failed at offset ${page * PAGE_SIZE}: ${lastFailure || "no response"}`);
    }

    pages++;
    out.push(...items);
    if (items.length < PAGE_SIZE) break;
    await sleep(250); // pace pages so we never re-trip a rate limit
  }

  return { bookings: out, pages };
}

/**
 * Rich detail for ONE booking — postal address, split name, and the `note`
 * field carrying the guest's NIF. Best-effort by design: a booking still bills
 * without it, with a thinner customer record.
 */
export async function getBookingDetail(apiKey, bookingId) {
  const res = await fetch(`${LODGIFY_API}/v1/reservation/booking/${encodeURIComponent(bookingId)}`, {
    headers: headersFor(apiKey),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 429) {
    const body = await res.text().catch(() => "");
    if (/unregistered API user|lodgify\.com\/partners|has been blocked/i.test(body)) throw new LodgifyBlockedError(body);
    return null;
  }
  if (!res.ok) return null;
  return await res.json().catch(() => null);
}

/** One-item read used to prove this egress can reach Lodgify at all. */
export async function probe(apiKey) {
  const t0 = Date.now();
  const res = await fetch(`${LODGIFY_API}/v1/reservation?offset=0&limit=1&trash=False`, {
    headers: headersFor(apiKey),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.text();
  let parsed = true;
  try { JSON.parse(body); } catch { parsed = false; }
  return {
    status: res.status,
    ms: Date.now() - t0,
    parsed,
    blocked: /unregistered API user|lodgify\.com\/partners|has been blocked/i.test(body),
    // Only surfaced on failure, and never contains the key.
    body: res.ok ? undefined : body.slice(0, 300),
  };
}
