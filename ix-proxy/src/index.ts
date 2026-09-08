/**
 * The InvoiceXpress proxy, rebuilt.
 *
 * WHY THIS EXISTS AT ALL
 *
 * InvoiceXpress's own API is v1, per-account, and awkward in three ways this
 * worker smooths over:
 *
 *  1. Credentials travel in the QUERY STRING (`?api_key=`), and the account is
 *     part of the HOSTNAME. Callers would each have to build a URL out of two
 *     secrets and remember which of two hostnames is the sandbox.
 *  2. Every document type is a different endpoint with a different envelope
 *     (`{invoice:{…}}`, `{invoice_receipt:{…}}`, `{credit_note:{…}}`), so a
 *     caller that issues both writes the same code twice.
 *  3. A line's tax must be an ACCOUNT TAX, by id or exact name. Sending
 *     `tax: 23` is refused — IX resolves it to an exempt tax and then demands
 *     an exemption reason. Every caller would need the account's tax table.
 *
 * WHY IT WAS REBUILT
 *
 * The previous proxy (ix-proxy.kapta.app) is still serving but its source could
 * not be found — not in any of our repositories, Cloudflare accounts or
 * backups. It validated request bodies against a closed schema, which silently
 * DROPPED any field the schema did not name. That is how multi-currency was
 * lost: InvoiceXpress accepts `currency_code` + `rate` and prints the second
 * currency on the document (measured against the sandbox 2026-09-08), but the
 * fields never reached it.
 *
 * So this one forwards the document body AS GIVEN. It validates what it must —
 * the document type, the ids, the state — and stays out of the way of
 * everything else, because the failure mode of a closed schema is a field that
 * vanishes without an error, and that costs more than a bad request would.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";

type Env = Record<string, never>;

/** The five document families IX exposes, and their path segments. */
const DOC_TYPES = {
  invoice: "invoices",
  invoice_receipt: "invoice_receipts",
  simplified_invoice: "simplified_invoices",
  credit_note: "credit_notes",
  debit_note: "debit_notes",
} as const;

type DocType = keyof typeof DOC_TYPES;

const isDocType = (v: unknown): v is DocType =>
  typeof v === "string" && Object.prototype.hasOwnProperty.call(DOC_TYPES, v);

/** The order to try when the caller does not say which type a document is. */
const GUESS_ORDER: DocType[] = ["invoice", "invoice_receipt", "credit_note", "simplified_invoice"];

interface IxAuth {
  account: string;
  apiKey: string;
  env: "prod" | "dev";
}

// ── Envelope ────────────────────────────────────────────────────────────────
// Every response carries the same four keys, because a caller that has to ask
// "which shape is this?" before reading an error will eventually not ask.

const ok = (data: unknown) => ({ data, success: true, error: null, metadata: {} });

const fail = (code: string, message: string | null, metadata: Record<string, unknown> = {}) =>
  ({ data: null, success: false, error: { message, code, metadata }, metadata: {} });

/**
 * The status a caller sees.
 *
 * InvoiceXpress answers a rejected document with 422; callers key on 4xx and
 * treat 5xx as "try again", so a validation refusal is reported as 400 and
 * anything upstream-broken as 502. Narrowed to a literal union because Hono
 * types the status, and a bare number here would let a 0 or a 599 through.
 */
type OutStatus = 400 | 401 | 404 | 502;
const outStatus = (upstream: number): OutStatus =>
  upstream === 401 ? 401
    : upstream === 404 ? 404
      : upstream >= 500 ? 502
        : 400;

// ── Talking to InvoiceXpress ────────────────────────────────────────────────

/**
 * The account's own hostname. The sandbox lives on a different subdomain, and
 * getting this wrong means writing test documents into a real fiscal account —
 * so it is derived from one header and never from anything the body says.
 */
function ixBase(auth: IxAuth): string {
  const suffix = auth.env === "prod" ? ".app.invoicexpress.com" : ".macewindu.invoicexpress.com";
  return `https://${auth.account}${suffix}`;
}

function readAuth(c: any): IxAuth | null {
  const account = String(c.req.header("x-account-name") ?? "").trim();
  const apiKey = String(c.req.header("x-api-key") ?? "").trim();
  if (!account || !apiKey) return null;
  const env = String(c.req.header("x-env") ?? "prod").trim() === "dev" ? "dev" : "prod";
  return { account, apiKey, env };
}

/**
 * One call to InvoiceXpress, with the api_key appended and the answer parsed.
 *
 * IX answers a failure in more than one shape — `{errors:[{error:"…"}]}` on a
 * validation error, `{errors:{code,message}}` elsewhere — and sometimes with
 * HTML. All three are folded into one error object here so the caller has a
 * single thing to read.
 */
async function ixCall(
  auth: IxAuth,
  path: string,
  init: RequestInit & { query?: Record<string, string> } = {},
): Promise<{ status: number; body: any; text: string }> {
  const url = new URL(ixBase(auth) + path);
  url.searchParams.set("api_key", auth.apiKey);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    method: init.method ?? "GET",
    headers: {
      "Accept": "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers as Record<string, string> ?? {}),
    },
    ...(init.body ? { body: init.body } : {}),
  });

  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* HTML or empty */ }
  return { status: res.status, body, text };
}

/** Turn whatever IX said into this proxy's error shape. */
function ixError(status: number, body: any, text: string) {
  const errors = body?.errors;
  if (Array.isArray(errors)) {
    const message = errors.map((e: any) => e?.error ?? e?.message).filter(Boolean).join("; ");
    return fail("UNKNOWN", message || "InvoiceXpress rejected the request", { jsonData: body });
  }
  if (errors && typeof errors === "object") {
    return fail(String(errors.code ?? "UNKNOWN"), errors.message ?? null, { jsonData: body });
  }
  return fail(
    status >= 500 ? "UPSTREAM_ERROR" : "UNKNOWN",
    body?.message ?? text.slice(0, 300) ?? null,
    { httpStatus: status },
  );
}

// ── The tax resolver ────────────────────────────────────────────────────────

/**
 * `?resolvers=on_tax_fallback_search_tax_by_value`
 *
 * Rewrites a line whose `tax` is a bare number into the account's own tax with
 * that value. Without it InvoiceXpress reads `tax: 23` as "no known tax",
 * silently applies the exempt one, and then refuses the document for having no
 * exemption reason. Callers that build lines from a payment processor's rates
 * have no way to know the account's tax names, so this is where that lookup
 * belongs.
 *
 * A rate with no matching account tax is left as the number. IX will refuse it,
 * which is the correct outcome: a shop selling at 20% into France must create
 * that tax before it can invoice it, and inventing a substitute here would put
 * the wrong rate on a fiscal document.
 */
async function resolveTaxesByValue(auth: IxAuth, data: any): Promise<void> {
  const items: any[] = Array.isArray(data?.items) ? data.items : [];
  const numeric = items.filter(it => typeof it?.tax === "number");
  if (numeric.length === 0) return;

  const { status, body } = await ixCall(auth, "/taxes.json");
  if (status >= 400) return;
  const taxes: any[] = body?.taxes ?? [];
  if (taxes.length === 0) return;

  for (const item of numeric) {
    const rate = Number(item.tax);
    const match = taxes.find(t => Number(t?.value) === rate);
    if (match?.id) item.tax = { id: Number(match.id), name: String(match.name), value: Number(match.value) };
  }
}

// ── Routes ──────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());

app.get("/", (c) => c.text("OK"));

/** The spec this worker answers to, kept beside the code that implements it. */
app.get("/openapi.json", (c) => c.json(OPENAPI));

app.use("/v2/*", async (c, next) => {
  if (!readAuth(c)) {
    return c.json(fail("UNAUTHENTICATED", "x-account-name and x-api-key are required"), 401);
  }
  await next();
});

/** Are these credentials real? Cheapest read IX offers. */
app.get("/v2/auth/check", async (c) => {
  const auth = readAuth(c)!;
  const { status, body, text } = await ixCall(auth, "/sequences.json");
  if (status >= 400) return c.json(ixError(status, body, text), outStatus(status));
  return c.json(ok({ account: auth.account, environment: auth.env }));
});

/** The account's tax table. */
app.get("/v2/taxes", async (c) => {
  const auth = readAuth(c)!;
  const { status, body, text } = await ixCall(auth, "/taxes.json");
  if (status >= 400) return c.json(ixError(status, body, text), 400);
  return c.json(ok({ taxes: body?.taxes ?? [] }));
});

/**
 * The account's document series.
 *
 * A series is a family: the row's own `id` is the invoice sequence, and each
 * document type has its own id inside it. Sending an invoice's id on an
 * invoice-receipt is refused by IX ("A série não corresponde ao tipo de
 * documento"), so all of them are passed through untouched rather than
 * flattened to one number.
 */
app.get("/v2/sequence", async (c) => {
  const auth = readAuth(c)!;
  const { status, body, text } = await ixCall(auth, "/sequences.json");
  if (status >= 400) return c.json(ixError(status, body, text), 400);
  return c.json(ok(body?.sequences ?? []));
});

/** Create a document of any type. */
app.post("/v2/documents", async (c) => {
  const auth = readAuth(c)!;
  const payload = await c.req.json().catch(() => null);
  const type = payload?.type;
  const data = payload?.data;

  if (!isDocType(type)) {
    return c.json(fail("VALIDATION_ERROR", `Unknown document type: ${String(type)}`), 400);
  }
  if (!data || typeof data !== "object") {
    return c.json(fail("VALIDATION_ERROR", "data is required"), 400);
  }

  if (c.req.query("resolvers")?.includes("on_tax_fallback_search_tax_by_value")) {
    await resolveTaxesByValue(auth, data);
  }

  const { status, body, text } = await ixCall(auth, `/${DOC_TYPES[type]}.json`, {
    method: "POST",
    body: JSON.stringify({ [type]: data }),
  });
  if (status >= 400) return c.json(ixError(status, body, text), outStatus(status));

  const doc = body?.[type] ?? body?.invoice ?? body;
  return c.json(ok(doc));
});

/** Create a credit note. Kept as its own route because callers reach for it by name. */
app.post("/v2/credit_notes", async (c) => {
  const auth = readAuth(c)!;
  const payload = await c.req.json().catch(() => null);
  const data = payload?.credit_note ?? payload?.data;
  if (!data || typeof data !== "object") {
    return c.json(fail("VALIDATION_ERROR", "credit_note is required"), 400);
  }

  if (c.req.query("resolvers")?.includes("on_tax_fallback_search_tax_by_value")) {
    await resolveTaxesByValue(auth, data);
  }

  const { status, body, text } = await ixCall(auth, "/credit_notes.json", {
    method: "POST",
    body: JSON.stringify({ credit_note: data }),
  });
  if (status >= 400) return c.json(ixError(status, body, text), outStatus(status));
  return c.json(ok(body?.credit_note ?? body));
});

/**
 * Read one document.
 *
 * `type` is optional: a caller holding only an id (from its own database, from
 * a webhook) should not have to remember which family it belongs to, so the
 * types are tried in turn. Passing `type` skips the guessing.
 */
app.get("/v2/documents/:id", async (c) => {
  const auth = readAuth(c)!;
  const id = c.req.param("id");
  const asked = c.req.query("type");
  const order = isDocType(asked) ? [asked] : GUESS_ORDER;

  let last: { status: number; body: any; text: string } | null = null;
  for (const type of order) {
    const res = await ixCall(auth, `/${DOC_TYPES[type]}/${encodeURIComponent(id)}.json`);
    if (res.status < 400) {
      const doc = res.body?.[type] ?? res.body?.invoice ?? res.body;
      return c.json(ok(doc));
    }
    last = res;
    // 404 means "not this family" — keep looking. Anything else is a real
    // failure and guessing further would only bury it.
    if (res.status !== 404) break;
  }
  return c.json(ixError(last?.status ?? 404, last?.body, last?.text ?? ""), outStatus(last?.status ?? 404));
});

/**
 * Replace a document.
 *
 * InvoiceXpress's PUT is a replacement, not a patch: a body without `items`
 * is refused, and a body with fewer items than the document has REPLACES them.
 * That is IX's rule, not this proxy's, and it is left as it is — softening it
 * here would mean guessing which of two versions of a fiscal document the
 * caller meant.
 */
app.put("/v2/documents/:id", async (c) => {
  const auth = readAuth(c)!;
  const id = c.req.param("id");
  const payload = await c.req.json().catch(() => null);
  const type = payload?.type;
  const data = payload?.data;

  if (!isDocType(type)) {
    return c.json(fail("VALIDATION_ERROR", `Unknown document type: ${String(type)}`), 400);
  }
  if (!data || typeof data !== "object") {
    return c.json(fail("VALIDATION_ERROR", "data is required"), 400);
  }

  if (c.req.query("resolvers")?.includes("on_tax_fallback_search_tax_by_value")) {
    await resolveTaxesByValue(auth, data);
  }

  const { status, body, text } = await ixCall(auth, `/${DOC_TYPES[type]}/${encodeURIComponent(id)}.json`, {
    method: "PUT",
    body: JSON.stringify({ [type]: data }),
  });
  if (status >= 400) return c.json(ixError(status, body, text), outStatus(status));
  return c.json(ok(body?.[type] ?? body ?? { id: Number(id) }));
});

/** Finalize, cancel or delete a document. */
app.post("/v2/change_state", async (c) => {
  const auth = readAuth(c)!;
  const payload = await c.req.json().catch(() => null);
  const type = payload?.type;
  const id = payload?.id;
  const state = payload?.state;

  if (!isDocType(type)) {
    return c.json(fail("VALIDATION_ERROR", `Unknown document type: ${String(type)}`), 400);
  }
  if (!id || !state) {
    return c.json(fail("VALIDATION_ERROR", "id and state are required"), 400);
  }

  const { status, body, text } = await ixCall(
    auth,
    `/${DOC_TYPES[type as DocType]}/${encodeURIComponent(String(id))}/change-state.json`,
    { method: "PUT", body: JSON.stringify({ [type]: { state } }) },
  );
  if (status >= 400) return c.json(ixError(status, body, text), outStatus(status));
  return c.json(ok(body?.[type as DocType] ?? body ?? { id: Number(id), state }));
});

/** Documents issued against this one — the credit notes that undo it. */
app.get("/v2/documents/:id/related", async (c) => {
  const auth = readAuth(c)!;
  const id = c.req.param("id");
  const { status, body, text } = await ixCall(auth, `/documents/${encodeURIComponent(id)}/related_documents.json`);
  if (status >= 400) return c.json(ixError(status, body, text), 400);
  return c.json(ok({ documents: body?.documents ?? [] }));
});

/** A URL a human can open: the document's own permalink, or the dashboard. */
app.get("/v2/documents/:id/link", async (c) => {
  const auth = readAuth(c)!;
  const id = c.req.param("id");
  const kind = c.req.query("type") ?? "permalink";
  if (kind !== "permalink" && kind !== "dashboard") {
    return c.json(fail("VALIDATION_ERROR", 'Invalid option: expected one of "permalink"|"dashboard"'), 400);
  }
  if (kind === "dashboard") {
    return c.json(ok({ url: `${ixBase(auth)}/documents/${encodeURIComponent(id)}` }));
  }

  for (const type of GUESS_ORDER) {
    const res = await ixCall(auth, `/${DOC_TYPES[type]}/${encodeURIComponent(id)}.json`);
    if (res.status < 400) {
      const doc = res.body?.[type] ?? res.body;
      return c.json(ok({ url: doc?.permalink ?? null }));
    }
    if (res.status !== 404) return c.json(ixError(res.status, res.body, res.text), 400);
  }
  return c.json(fail("DOCUMENT_NOT_FOUND", `Document ${id} not found`), 404);
});

/** Send the document to the buyer, through InvoiceXpress's own mail. */
app.post("/v2/documents/:id/email", async (c) => {
  const auth = readAuth(c)!;
  const id = c.req.param("id");
  const asked = c.req.query("type");
  const type: DocType = isDocType(asked) ? asked : "invoice";
  const payload = await c.req.json().catch(() => null);

  const message = payload?.message ?? payload;
  if (!message?.client?.email) {
    return c.json(fail("VALIDATION_ERROR", "message.client.email is required"), 400);
  }

  const { status, body, text } = await ixCall(
    auth,
    `/${DOC_TYPES[type]}/${encodeURIComponent(id)}/email-document.json`,
    { method: "PUT", body: JSON.stringify({ message }) },
  );
  if (status >= 400) return c.json(ixError(status, body, text), outStatus(status));
  return c.json(ok({ id: Number(id), sent: true }));
});

/**
 * Find a document by the reference we stamped on it.
 *
 * This is the dedup key: before issuing, a caller asks whether this sale
 * already has a document. IX has no exact-reference lookup, only a full-text
 * search, so the match is verified here rather than trusting the first hit —
 * "Order #12" would otherwise match "Order #120".
 */
app.post("/v2/documents/reference", async (c) => {
  const auth = readAuth(c)!;
  const payload = await c.req.json().catch(() => null);
  const reference = String(payload?.reference ?? "").trim();
  // An empty reference answers "not found", not "bad request". The caller reads
  // a 404 as "no document exists, go ahead and issue one" and anything else as
  // "the lookup failed" — which aborts the sale. The proxy this replaces
  // answered 404 here, and a swap-in replacement does not get to be stricter on
  // the one path that decides whether a duplicate fiscal document is created.
  if (!reference) return c.json(fail("DOCUMENT_NOT_FOUND", 'Document with reference "" not found'), 404);

  for (const type of GUESS_ORDER) {
    const { status, body } = await ixCall(auth, `/${DOC_TYPES[type]}.json`, {
      query: { text: reference, per_page: "30" },
    });
    if (status >= 400) continue;
    const list: any[] = body?.[DOC_TYPES[type]] ?? body?.invoices ?? [];
    const hit = list.find(d => String(d?.reference ?? "").trim() === reference);
    if (hit?.id) {
      return c.json(ok({ id: Number(hit.id), type, state: String(hit.status ?? "") }));
    }
  }

  return c.json(fail("DOCUMENT_NOT_FOUND", `Document with reference "${reference}" not found`), 404);
});

/** The error codes a caller may see, so it can key on them without guessing. */
app.get("/v2/meta/error-codes", (c) => c.json(ok({
  codes: [
    { code: "UNAUTHENTICATED", meaning: "x-account-name / x-api-key missing or refused by IX" },
    { code: "VALIDATION_ERROR", meaning: "the request itself is malformed" },
    { code: "DOCUMENT_NOT_FOUND", meaning: "no document matched" },
    { code: "UPSTREAM_ERROR", meaning: "InvoiceXpress answered 5xx" },
    { code: "UNKNOWN", meaning: "InvoiceXpress refused it and said why in the message" },
  ],
})));

/**
 * The spec, hand-kept rather than generated, because the client this serves is
 * generated FROM it (see generate.ts in the worker repo): a field missing here
 * is a field the caller cannot type, even though the proxy would forward it.
 */
const OPENAPI = {
  openapi: "3.0.0",
  info: { title: "InvoiceXpress Proxy", version: "2.0.0" },
  servers: [{ url: "https://ix.rioko.online" }],
  paths: {
    "/v2/documents": {
      post: {
        parameters: [
          { name: "resolvers", in: "query", schema: { type: "string" }, required: false },
          { name: "x-account-name", in: "header", schema: { type: "string" }, required: true },
          { name: "x-api-key", in: "header", schema: { type: "string" }, required: true },
          { name: "x-env", in: "header", schema: { type: "string", enum: ["prod", "dev"] }, required: false },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  type: { type: "string", enum: Object.keys(DOC_TYPES) },
                  data: {
                    type: "object",
                    // Deliberately open: the previous proxy's closed schema is
                    // what silently dropped currency_code and rate. The named
                    // fields are the ones callers type against.
                    additionalProperties: true,
                    properties: {
                      date: { type: "string" },
                      due_date: { type: "string" },
                      reference: { type: "string" },
                      observations: { type: "string" },
                      tax_exemption_reason: { type: "string" },
                      sequence_id: { type: "number" },
                      currency_code: { type: "string", description: "ISO 4217. Prints a second currency on the document." },
                      rate: { type: "string", description: "Decimal as a string. Foreign units per 1 unit of the account currency." },
                      retention: { type: "string" },
                      client: { type: "object", additionalProperties: true },
                      items: { type: "array", items: { type: "object", additionalProperties: true } },
                    },
                  },
                },
                required: ["type", "data"],
              },
            },
          },
        },
        responses: { 200: { description: "Created" }, 400: { description: "Refused" } },
      },
    },
  },
} as const;

export default app;
