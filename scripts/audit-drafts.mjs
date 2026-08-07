// STUCK-DRAFT AUDIT (read-only by default).
//
// Every draft sitting in a merchant's InvoiceXpress account is checked against
// the Shopify order it claims to represent, and classified:
//
//   OK      — safe to finalize: the order is paid, the document's gross equals
//             what the customer actually paid, and no issued document already
//             exists for that order.
//   PROBLEM — anything else, with the reason. These are never finalized.
//   SKIP    — not ours to touch (no processed_orders row, or held on purpose).
//
// Why the gross check is the centre of it: a fiscal document must total exactly
// the amount the customer paid. Finalizing is irreversible — a wrong one can
// only be undone with a credit note — so a draft that disagrees with Shopify by
// a cent gets listed, not certified.
//
//   node scripts/audit-drafts.mjs                      # audit every auto_finalize shop
//   SHOP=x.myshopify.com node scripts/audit-drafts.mjs # one shop
//   APPLY=1 node scripts/audit-drafts.mjs              # finalize the OK ones
//
// APPLY finalizes at the date closest to the transaction that IX accepts: the
// draft's own date first, then the series' last finalized date, then today —
// moving due_date with date (IX rejects due_date < date, which is what broke
// the nightly sweep) and stamping the real order date into the observations.
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const ONLY = process.env.SHOP || null;
const APPLY = process.env.APPLY === "1";
const OUT = process.env.OUT || "draft-audit.json";
const PROXY = "https://ix-proxy.kapta.app";
const CENT = 0.011; // a cent, plus float slack

// `wrangler d1 execute --remote` intermittently returns a transient 7403 that
// has nothing to do with the query. Retry rather than abandoning a whole shop.
const wq = (sql, attempt = 0) => {
  try {
    const raw = execSync(`npx wrangler d1 execute rioko-db --remote --json --command "${sql.replace(/"/g, '\\"')}"`, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    return JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1))[0].results;
  } catch (e) {
    if (attempt >= 3) throw e;
    execSync(process.platform === "win32" ? "timeout /t 3 /nobreak > NUL" : "sleep 3", { stdio: "ignore" });
    return wq(sql, attempt + 1);
  }
};

/** Portuguese contribuinte, mod-11. Mirrors src/ix/nif.ts. */
function validatePTNIF(nif) {
  const s = String(nif ?? "").replace(/\D/g, "");
  if (s.length !== 9) return false;
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += Number(s[i]) * (9 - i);
  const mod = sum % 11;
  const check = mod < 2 ? 0 : 11 - mod;
  return check === Number(s[8]);
}

const ixHeaders = (cfg) => ({
  "x-account-name": cfg.ix_account_name,
  "x-api-key": cfg.ix_api_key,
  "x-env": cfg.ix_environment === "production" ? "prod" : "dev",
  Accept: "application/json",
  "Content-Type": "application/json",
});

async function listDrafts(cfg) {
  const path = cfg.ix_document_type === "invoice_receipt" ? "invoice_receipts.json" : "invoices.json";
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const url = `https://${cfg.ix_account_name}.app.invoicexpress.com/${path}?api_key=${cfg.ix_api_key}&status%5B%5D=draft&per_page=100&page=${page}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`IX list HTTP ${res.status}`);
    const d = await res.json();
    const list = d?.invoices ?? d?.invoice_receipts ?? [];
    out.push(...list);
    if (page >= Number(d?.pagination?.total_pages ?? 1) || list.length === 0) break;
  }
  return out;
}

/**
 * The list endpoint's `total` is NOT trustworthy — measured live on a
 * zero-tax draft it reported 31.00 where the document itself holds 27.29. Every
 * number this audit decides on therefore comes from the document GET.
 */
async function getDoc(cfg, id) {
  const res = await fetch(`${PROXY}/v2/documents/${id}`, { headers: ixHeaders(cfg) });
  if (!res.ok) return null;
  const j = await res.json();
  return j?.data ?? j ?? null;
}

/** Bounded parallelism — the IX proxy is fine with a handful of readers. */
async function mapPool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}

/** Shopify orders by id, batched — one request per 50 ids. */
async function fetchOrders(cfg, ids) {
  const ver = cfg.shopify_api_version || "2026-01";
  const byId = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const url = `https://${cfg.shopify_domain}/admin/api/${ver}/orders.json?status=any&ids=${chunk.join(",")}&limit=250`;
    const res = await fetch(url, { headers: { "X-Shopify-Access-Token": cfg.shopify_token, Accept: "application/json" } });
    if (!res.ok) throw new Error(`Shopify orders HTTP ${res.status}`);
    const d = await res.json();
    for (const o of d.orders ?? []) byId.set(String(o.id), o);
  }
  return byId;
}

/** Is there an ISSUED document for this reference already? Double-invoicing guard. */
async function issuedDocForReference(cfg, reference, draftId) {
  const res = await fetch(`${PROXY}/v2/documents/reference`, {
    method: "POST",
    headers: ixHeaders(cfg),
    body: JSON.stringify({ reference }),
  });
  if (!res.ok) return null;
  const j = await res.json();
  const found = j?.data ?? j;
  if (!found?.id || String(found.id) === String(draftId)) return null;
  const state = found.status ?? found.state;
  return state && state !== "draft" ? { id: found.id, status: state } : null;
}

function parsePtDate(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s ?? ""));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
const fmtPt = (ymd) => { const [y, m, d] = ymd.split("-"); return `${d}/${m}/${y}`; };
const todayYmd = () => new Date().toISOString().slice(0, 10);

async function seriesLastFinalizedDate(cfg) {
  const path = cfg.ix_document_type === "invoice_receipt" ? "invoice_receipts.json" : "invoices.json";
  const url = `https://${cfg.ix_account_name}.app.invoicexpress.com/${path}?api_key=${cfg.ix_api_key}&status%5B%5D=settled&status%5B%5D=final&order_by=date_desc&per_page=1`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  const d = await res.json();
  const list = d?.invoices ?? d?.invoice_receipts ?? [];
  return list.length ? parsePtDate(list[0]?.date) : null;
}

/** Same policy as src/handlers/admin.ts finalizeDraftClosestToDate. */
async function finalizeClosest(cfg, doc, seriesLast) {
  const type = cfg.ix_document_type === "invoice_receipt" ? "invoice_receipt" : "invoice";
  const originalDate = parsePtDate(doc.date);
  if (!originalDate) return { ok: false, error: `unparseable date ${doc.date}` };
  const candidates = [...new Set([originalDate, seriesLast, todayYmd()].filter((d) => d && d >= originalDate).sort())];

  // The list payload is thin; the PUT has to send the document back whole.
  const full = await (await fetch(`${PROXY}/v2/documents/${doc.id}`, { headers: ixHeaders(cfg) })).json();
  const fd = full?.data ?? full;
  const existingObs = typeof fd.observations === "string" ? fd.observations.trim() : "";
  const om = /Order #(\d+)/i.exec(String(fd.reference ?? ""));

  let current = originalDate, lastError = "";
  for (const target of candidates) {
    if (target !== current) {
      const note = om ? `Fatura referente à encomenda #${om[1]} de ${fmtPt(originalDate)}` : null;
      const observations = note ? (existingObs ? `${existingObs} | ${note}` : note).slice(0, 200) : existingObs;
      const body = {
        type,
        data: {
          date: target,
          due_date: target,
          client: fd.client ? {
            ...(fd.client.id ? { id: Number(fd.client.id) } : {}),
            ...(fd.client.name ? { name: String(fd.client.name) } : {}),
            ...(fd.client.email ? { email: String(fd.client.email) } : {}),
            ...(fd.client.fiscal_id ? { fiscal_id: String(fd.client.fiscal_id) } : {}),
            ...(fd.client.address ? { address: String(fd.client.address) } : {}),
            ...(fd.client.postal_code ? { postal_code: String(fd.client.postal_code) } : {}),
            ...(fd.client.country ? { country: String(fd.client.country) } : {}),
            ...(fd.client.city ? { city: String(fd.client.city) } : {}),
            ...(fd.client.phone ? { phone: String(fd.client.phone) } : {}),
          } : { name: "" },
          items: (fd.items ?? []).map((it) => ({
            quantity: Number(it.quantity),
            name: String(it.name ?? ""),
            ...(it.description ? { description: String(it.description) } : {}),
            unit_price: Number(it.unit_price),
            tax: it.tax?.id
              ? { id: Number(it.tax.id), name: String(it.tax.name ?? ""), value: Number(it.tax.value ?? 0) }
              : { name: String(it.tax?.name ?? ""), value: Number(it.tax?.value ?? 0) },
            ...(typeof it.discount === "number" && it.discount > 0 ? { discount: it.discount } : {}),
          })),
          observations,
          ...(fd.reference ? { reference: String(fd.reference) } : {}),
          ...(fd.tax_exemption ? { tax_exemption_reason: String(fd.tax_exemption) } : {}),
        },
      };
      const put = await fetch(`${PROXY}/v2/documents/${doc.id}`, { method: "PUT", headers: ixHeaders(cfg), body: JSON.stringify(body) });
      if (!put.ok) return { ok: false, error: `PUT ${fmtPt(target)}: HTTP ${put.status} ${(await put.text()).slice(0, 200)}` };
      current = target;
    }
    const chg = await fetch(`${PROXY}/v2/change_state`, {
      method: "POST",
      headers: ixHeaders(cfg),
      body: JSON.stringify({ type, id: Number(doc.id), state: "finalized" }),
    });
    if (chg.ok) return { ok: true, date: target, moved: target !== originalDate, originalDate };
    lastError = `HTTP ${chg.status} ${(await chg.text()).slice(0, 300)}`;
    const low = lastError.toLowerCase();
    const dateish = ["vencimento", "due date", "data do documento", "document date", "sequencial", "sequential", "sequence", "sequência", "date cannot be earlier", "não pode ser anterior", "nao pode ser anterior"].some((k) => low.includes(k));
    if (!dateish) return { ok: false, error: lastError };
  }
  return { ok: false, error: lastError || "no acceptable date" };
}

const COLS = "user_id, shopify_domain, shopify_token, shopify_api_version, ix_account_name, ix_api_key, ix_environment, ix_document_type, auto_finalize, is_paused";

async function auditShop(dom) {
  const cfg = wq(`SELECT ${COLS} FROM integrations WHERE shopify_domain='${dom}'`)[0];
  const listed = await listDrafts(cfg);
  const full = await mapPool(listed, 6, (d) => getDoc(cfg, d.id));
  // Keep the list entry only as a fallback for a document we could not read.
  const drafts = listed.map((d, i) => full[i] ?? d);
  // Look up only the drafts we found. Pulling a high-volume shop's whole
  // processed_orders table (tens of thousands of rows) overflows the D1 HTTP
  // response and fails the audit for exactly the shops that need it most.
  const rows = [];
  const ids = drafts.map((d) => Number(d.id)).filter(Number.isFinite);
  for (let i = 0; i < ids.length; i += 150) {
    rows.push(...wq(`SELECT id, invoice_id, hold_reason FROM processed_orders WHERE shopify_domain='${dom}' AND invoice_id IN (${ids.slice(i, i + 150).join(",")})`));
  }
  const orderByInvoice = new Map(rows.map((r) => [String(r.invoice_id), r]));

  const linked = drafts.filter((d) => orderByInvoice.has(String(d.id)));
  const orderIds = [...new Set(linked.map((d) => orderByInvoice.get(String(d.id)).id))];
  const orders = orderIds.length ? await fetchOrders(cfg, orderIds) : new Map();

  const report = { shop: dom, account: cfg.ix_account_name, drafts: drafts.length, ok: [], problems: [], skipped: [] };

  for (const d of drafts) {
    const row = orderByInvoice.get(String(d.id));
    const base = { invoice_id: d.id, reference: d.reference ?? null, date: d.date, total: Number(d.total), client: d.client?.name ?? null };

    if (!row) { report.skipped.push({ ...base, reason: "sem linha em processed_orders — documento criado fora da integração" }); continue; }
    base.order_id = row.id;
    if (row.hold_reason) { report.skipped.push({ ...base, reason: `retido de propósito: ${row.hold_reason}` }); continue; }

    const o = orders.get(String(row.id));
    if (!o) { report.problems.push({ ...base, reasons: ["encomenda não encontrada no Shopify (apagada ou fora do alcance do token)"] }); continue; }

    const reasons = [];
    const paid = Number(o.total_price);
    const ixTotal = Number(d.total);

    if (o.cancelled_at) reasons.push(`encomenda cancelada no Shopify em ${o.cancelled_at}`);
    if (o.financial_status !== "paid") reasons.push(`financial_status = ${o.financial_status} (não está paga)`);
    if (!Number.isFinite(ixTotal) || ixTotal <= 0) reasons.push(`total do documento = ${d.total}`);
    if (Array.isArray(d.items) && d.items.length === 0) reasons.push("documento sem linhas");
    if (Number.isFinite(paid) && Number.isFinite(ixTotal) && Math.abs(paid - ixTotal) > CENT) {
      reasons.push(`total diverge: documento ${ixTotal.toFixed(2)} vs pago ${paid.toFixed(2)} (${(ixTotal - paid).toFixed(2)})`);
    }
    // A document at 0% for an order where the customer demonstrably paid VAT.
    // The gross check above normally catches it, but flag the cause by name so
    // the list says what is wrong, not just that a number disagrees.
    const paidTax = Number(o.total_tax);
    if (Number.isFinite(paidTax) && paidTax > 0.005 && Number(d.taxes ?? 0) <= 0.005) {
      reasons.push(`documento a 0% de IVA mas o cliente pagou ${paidTax.toFixed(2)} de imposto`);
    }
    const ixCur = String(d.currency ?? "").toLowerCase();
    const shCur = String(o.currency ?? "").toLowerCase();
    if (ixCur && shCur && !ixCur.startsWith(shCur.slice(0, 3)) && !(ixCur === "euro" && shCur === "eur")) {
      reasons.push(`moeda diverge: documento ${d.currency} vs encomenda ${o.currency}`);
    }
    const fid = String(d.client?.fiscal_id ?? "").trim();
    if (fid) {
      const isPt = String(d.client?.country ?? o.billing_address?.country ?? "").toLowerCase().startsWith("portugal");
      if (/^\d{9}$/.test(fid) && isPt && !validatePTNIF(fid)) reasons.push(`NIF inválido no cliente: ${fid}`);
      if (/^[A-Z]{2}[A-Z]/i.test(fid) && (fid.match(/\d/g) ?? []).length < 5) reasons.push(`fiscal_id parece uma palavra da morada: ${fid}`);
    }
    const dup = await issuedDocForReference(cfg, String(d.reference ?? ""), d.id);
    if (dup) reasons.push(`já existe documento emitido ${dup.id} (${dup.status}) para ${d.reference}`);

    base.order_number = o.order_number;
    base.paid = Number.isFinite(paid) ? Number(paid.toFixed(2)) : null;
    if (reasons.length) report.problems.push({ ...base, reasons });
    else report.ok.push(base);
  }

  if (APPLY && report.ok.length) {
    let seriesLast = await seriesLastFinalizedDate(cfg);
    report.finalized = [];
    report.finalize_failed = [];
    // OLDEST FIRST. IX refuses to issue a document dated before the series' last
    // one, so finalizing the newest draft first would push the baseline past
    // every older draft and force them all onto today's date. Going forward in
    // time lets each document keep the day its sale actually happened.
    const queue = [...report.ok].sort((a, b) => (parsePtDate(a.date) ?? "").localeCompare(parsePtDate(b.date) ?? ""));
    for (const item of queue) {
      const draft = drafts.find((d) => String(d.id) === String(item.invoice_id));
      const res = await finalizeClosest(cfg, draft, seriesLast);
      if (res.ok) {
        report.finalized.push({ ...item, finalized_date: fmtPt(res.date), moved: res.moved });
        // The series baseline just moved — carry it so the next draft aims at a
        // date IX will actually take instead of burning a rejected attempt.
        if (!seriesLast || res.date > seriesLast) seriesLast = res.date;
      } else {
        report.finalize_failed.push({ ...item, error: res.error });
      }
    }
  }
  return report;
}

const shops = ONLY
  ? [ONLY]
  : wq(`SELECT shopify_domain FROM integrations WHERE auto_finalize=1 AND is_paused=0 AND shopify_domain IS NOT NULL`).map((r) => r.shopify_domain);

const all = [];
for (const dom of shops) {
  try {
    const r = await auditShop(dom);
    all.push(r);
    const fin = r.finalized ? `, finalizados ${r.finalized.length}, falhou ${r.finalize_failed.length}` : "";
    console.log(`${dom}: drafts ${r.drafts} → OK ${r.ok.length}, PROBLEMA ${r.problems.length}, ignorados ${r.skipped.length}${fin}`);
  } catch (e) {
    console.log(`${dom}: ERRO ${String(e?.message ?? e).slice(0, 200)}`);
    all.push({ shop: dom, error: String(e?.message ?? e) });
  }
}
writeFileSync(OUT, JSON.stringify(all, null, 1));
console.log(`\nRelatório: ${OUT}`);
