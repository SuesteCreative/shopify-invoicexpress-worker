// DRY RUN for the REFUND / credit-note path. READ-ONLY: no POST, no
// changeState, no D1 writes. It replays every real refund of every active shop
// through the mirror planner and prints, per refund, the credit note that WOULD
// be issued and whether it totals exactly what was refunded.
//
// It replaced a shadow diff between two normalizers, which had gone stale: that
// version still reproduced the arithmetic this change deletes (a rate derived
// from the refund's own subtotal, a "Refund amount" line at the invoice's
// highest rate), so it validated the bug rather than the fix.
//
//   npm run shadow:refund
//   SHOP=166c6d-82.myshopify.com npm run shadow:refund
//   SCAN=50 npm run shadow:refund
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { IxBuilder } from "./.gen/builder.mjs";
import { mirrorItemsFromIxDocument, moneyRefunded, planRefundCredit } from "./.gen/credit-mirror.mjs";

const ONLY = process.env.SHOP || null;
const SCAN = Number(process.env.SCAN ?? 200);     // refunded orders scanned per shop
const IX_BASE = process.env.IX_PROXY_URL || "https://ix.rioko.online";
const wrangler = readFileSync("wrangler.jsonc", "utf8");
const NKEY = (wrangler.match(/"NORMALIZE_SHOPIFY_ORDER_API_KEY"\s*:\s*"([^"]+)"/) || [])[1] || "";

const _log = console.log, _err = console.error;
const mute = () => { console.log = () => {}; console.error = () => {}; };
const unmute = () => { console.log = _log; console.error = _err; };

const wq = (sql) => {
  const raw = execSync(`npx wrangler d1 execute rioko-db --remote --json --command "${sql}"`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1))[0].results;
};

const CFG = ["user_id","shopify_domain","shopify_token","shopify_api_version","ix_account_name","ix_api_key","ix_environment","ix_document_type","ix_exemption_reason","ix_b2b_exemption_reason","ix_stamp_exemption_note","force_tax_rate","force_shipping_tax_rate","vat_included","oss_enabled","b2b_reverse_charge","auto_finalize","pos_mode","ix_retention_enabled","ix_retention","is_paused","ix_derive_exemption","ix_adapter_safety_nets","ix_require_series"];
const NUMERIC = ["ix_stamp_exemption_note","force_tax_rate","force_shipping_tax_rate","vat_included","oss_enabled","b2b_reverse_charge","auto_finalize","pos_mode","ix_retention_enabled","ix_retention","is_paused","ix_derive_exemption","ix_adapter_safety_nets","ix_require_series"];

function loadConfig(dom) {
  const r = wq(`SELECT ${CFG.join(", ")} FROM integrations WHERE shopify_domain='${dom}'`)[0];
  for (const k of NUMERIC) r[k] = r[k] == null ? null : Number(r[k]);
  return r;
}
function loadShops() {
  return wq("SELECT shopify_domain FROM integrations WHERE shopify_domain IS NOT NULL AND shopify_domain!='' AND shopify_token IS NOT NULL AND shopify_token!='' AND ix_api_key IS NOT NULL AND ix_api_key!='' AND COALESCE(is_paused,0)=0 ORDER BY shopify_domain").map(r => r.shopify_domain);
}
function loadInvoiceIds(dom) {
  const rows = wq(`SELECT id, invoice_id FROM processed_orders WHERE shopify_domain='${dom}' AND invoice_id IS NOT NULL`);
  return new Map(rows.map(r => [String(r.id), String(r.invoice_id)]));
}

async function fetchOrdersWithRefunds(cfg) {
  const ver = cfg.shopify_api_version || "2026-01";
  const url = `https://${cfg.shopify_domain}/admin/api/${ver}/orders.json?status=any&limit=250`;
  const res = await fetch(url, { headers: { "X-Shopify-Access-Token": cfg.shopify_token, "Accept": "application/json" } });
  if (!res.ok) return [];
  const { orders } = await res.json();
  return (orders ?? []).filter(o => Array.isArray(o.refunds) && o.refunds.length > 0).slice(0, SCAN);
}

async function hostinger(cfg, orderId, raw) {
  const url = `https://endpoint-shopify.srv1250352.hstgr.cloud/orders/normalize/${orderId}`;
  const h = { "x-api-key": NKEY.trim(), "shop-url": cfg.shopify_domain, "access-token": cfg.shopify_token, "Accept": "application/json" };
  const hn = await fetch(url, { headers: h, signal: AbortSignal.timeout(15000) }).then(r => r.ok ? r.json() : null).catch(() => null);
  if (hn?.normalized) hn.normalized.raw_order = raw;
  return hn;
}

const ixHeaders = (cfg) => ({
  "x-account-name": cfg.ix_account_name,
  "x-api-key": cfg.ix_api_key,
  "x-env": cfg.ix_environment === "production" ? "prod" : "dev",
  Accept: "application/json",
});
const ixGet = async (cfg, path) =>
  fetch(`${IX_BASE}${path}`, { headers: ixHeaders(cfg) }).then(r => r.json()).catch(() => null);

const taxval = (t) => (typeof t === "number" ? t : (t?.value ?? null));
const money = (n) => Number(n).toFixed(2);

/** What TODAY's deployed code would have sent — kept only to show the difference. */
function todaysLines(credit, norm, builder) {
  const r2 = (n) => Math.round(n * 100) / 100;
  const byId = new Map((norm.order.items ?? []).map(it => [it.id, it]));
  const out = [];
  for (const li of credit.line_items ?? []) {
    const net = Number(li.subtotal), tax = Number(li.total_tax ?? 0);
    if (!(net > 0) && !(tax > 0)) continue;
    const oi = byId.get(li.id);
    out.push({
      quantity: Number(li.quantity) || 1,
      tax: net > 0 ? r2((tax / net) * 100) : 0,
      unit_price: net / (Number(li.quantity) || 1),
      name: oi ? (oi.variant_title ? `${oi.title} / ${oi.variant_title}` : oi.title) : `Item devolvido #${li.id}`,
    });
  }
  let gross = 0; try { gross = builder.computeIxExpectedTotal(out); } catch {}
  return { items: out, gross };
}

console.log(`\n=== DRY RUN — credit notes as mirrors of the invoice (read-only) ===\n`);
if (!NKEY) { console.error("NORMALIZE_SHOPIFY_ORDER_API_KEY missing"); process.exit(1); }

const shops = ONLY ? [ONLY] : loadShops();
let seen = 0, mirrored = 0, refused = 0, nothing = 0, exactness = 0, noInvoice = 0, hostFail = 0, cancellations = 0;
const uncredited = [];
let wouldDifferFromToday = 0;
const refusals = new Map();
const overCredited = [], duplicateRefs = [];

for (const dom of shops) {
  const cfg = loadConfig(dom);
  const builder = new IxBuilder(cfg);
  const invoiceIds = loadInvoiceIds(dom);
  const orders = await fetchOrdersWithRefunds(cfg);
  if (orders.length === 0) { console.log(`Shop ${dom}: no refunded orders`); continue; }
  console.log(`\nShop ${dom}: ${orders.length} refunded order(s)`);

  for (const raw of orders) {
    const invoiceId = invoiceIds.get(String(raw.id));
    if (!invoiceId) { noInvoice++; continue; }

    const docBody = await ixGet(cfg, `/v2/documents/${invoiceId}`);
    const doc = docBody?.data;
    if (!doc?.total) { console.log(`  #${raw.order_number}: could not read document ${invoiceId}`); continue; }

    // Two flags that fall out of the same pass, at no extra cost.
    const relBody = await ixGet(cfg, `/v2/documents/${invoiceId}/related`);
    const live = (relBody?.data?.documents ?? []).filter(d =>
      d.type === "CreditNote" && !["canceled", "cancelled", "deleted"].includes(String(d.status ?? "").toLowerCase()));
    // A draft credits nothing — only a certified note moves money. Counting the
    // nine abandoned drafts on one invoice reported 940,95 € "credited" on 89,49 €.
    const liveTotal = live
      .filter(d => String(d.status ?? "").toLowerCase() !== "draft")
      .reduce((s, d) => s + Number(d.total ?? 0), 0);
    if (liveTotal - Number(doc.total) > 0.01) overCredited.push(`${dom} doc ${invoiceId}: ${money(liveTotal)} creditado sobre ${money(doc.total)}`);
    const refCount = live.reduce((m, d) => m.set(d.reference, (m.get(d.reference) ?? 0) + 1), new Map());
    for (const [ref, n] of refCount) if (n > 1) duplicateRefs.push(`${dom} doc ${invoiceId}: ${n} notas com a referência "${ref}"`);
    // What already stands against this invoice, so a planned note can be read
    // next to the ones that exist (or do not).
    console.log(`  #${raw.order_number}  fatura ${invoiceId}: ${money(doc.total)} €, encomenda vale agora ${raw.current_total_price} ${raw.currency}, `
      + (live.length
        ? `${live.length} nota(s) de crédito no IX: ${live.map(d => `${d.sequence_number ?? d.id} ${String(d.status)} ${money(d.total)}`).join(", ")}`
        : `sem notas de crédito no IX`));

    const hn = await hostinger(cfg, String(raw.id), raw);
    if (!hn?.normalized) { hostFail++; continue; }
    const norm = hn.normalized;

    let docItems;
    mute();
    try { docItems = mirrorItemsFromIxDocument(doc).items; } catch (e) { unmute(); console.log(`  #${raw.order_number}: ${String(e?.message ?? e).slice(0, 140)}`); continue; }
    const trace = [];
    let rebuilt;
    try { rebuilt = builder.buildInvoiceItemsFromRaw(raw, { trace }); } catch { rebuilt = undefined; }
    unmute();

    let credited = 0;
    for (const credit of norm.credits ?? []) {
      seen++;
      const rawRefund = (raw.refunds ?? []).find(r => String(r.id) === String(credit.refund_id)) ?? null;
      mute();
      const plan = planRefundCredit({
        docTotal: Number(doc.total),
        docItems,
        sources: trace,
        refund: { refundId: credit.refund_id, amount: Number(credit.amount), lineItems: credit.line_items ?? [] },
        rawRefund,
        taxesIncluded: raw.taxes_included === true,
        alreadyCredited: credited,
        orderCurrentTotal: raw.currency === "EUR" ? Number(raw.current_total_price) : null,
        rebuilt,
      });
      const today = todaysLines(credit, norm, builder);
      unmute();

      // The money the transactions paid back — the figure a credit note must hit.
      const paidBack = moneyRefunded(rawRefund, Number(credit.amount));
      console.log(`  #${raw.order_number}  refund ${credit.refund_id}  devolvido ${money(paidBack)}`
        + `${Math.abs(paidBack - Number(credit.amount)) > 0.01 ? `  (o normalizador dizia ${money(credit.amount)})` : ""}`);
      if (plan.ok) {
        mirrored++;
        credited += plan.total;
        // Money that moved must equal the mirror to the cent. A cancellation moved
        // no money at all; there the invariant is that the invoice lands on — and
        // never below — what the order is worth now.
        const cancellation = paidBack <= 0.005;
        const orderNow = raw.currency === "EUR" ? Number(raw.current_total_price) : null;
        const leftOnInvoice = Math.round((Number(doc.total) - credited) * 100) / 100;   // `credited` already includes this note
        const exact = cancellation
          ? orderNow != null && leftOnInvoice >= orderNow - 0.01
          : Math.abs(plan.total - paidBack) <= 0.01;
        if (exact) exactness++;
        if (cancellation) cancellations++;
        if (live.length === 0) {
          uncredited.push(`${dom} #${raw.order_number} refund ${credit.refund_id}: ${money(plan.total)} € `
            + `(${cancellation ? "anulação" : "reembolso"}) — fatura ${invoiceId} sem nota de crédito no IX`);
        }
        console.log(`    ESPELHO (${plan.basis})${cancellation ? " — anulação, sem transação de reembolso" : ""}`);
        for (const it of plan.items) {
          console.log(`      ${it.quantity} x "${String(it.name).slice(0, 48)}"  unit ${money(it.unit_price)}`
            + `${it.discount ? `  desc ${it.discount}%` : ""}  IVA ${taxval(it.tax)}%`);
        }
        console.log(cancellation
          ? `    total ${money(plan.total)} — a fatura fica em ${money(leftOnInvoice)} e a encomenda vale ${orderNow == null ? "?" : money(orderNow)}  ${exact ? "OK" : "DESALINHADO"}`
          : `    total ${money(plan.total)} vs devolvido ${money(paidBack)}  ${exact ? "OK" : "DESALINHADO"}`);
        const todayRates = today.items.map(i => i.tax).join("/");
        const mirrorRates = plan.items.map(i => taxval(i.tax)).join("/");
        if (today.items.length && (todayRates !== mirrorRates || Math.abs(today.gross - plan.total) > 0.01)) {
          wouldDifferFromToday++;
          console.log(`    (o código actual enviaria IVA ${todayRates} num total de ${money(today.gross)})`);
        }
      } else if (plan.nothingToCredit) {
        nothing++;
        console.log(`    NADA A CREDITAR: ${plan.reason}`);
      } else {
        refused++;
        refusals.set(plan.reason.slice(0, 80), (refusals.get(plan.reason.slice(0, 80)) ?? 0) + 1);
        console.log(`    RECUSA: ${plan.reason}`);
      }
    }
  }
}

console.log(`\n================ RESUMO ================`);
console.log(`  reembolsos vistos=${seen}  espelhados=${mirrored}  recusados=${refused}  sem dinheiro devolvido=${nothing}`);
console.log(`  espelhos certos (reembolso: total = dinheiro devolvido; anulação: fatura não fica abaixo da encomenda): ${exactness}/${mirrored}  — anulações: ${cancellations}`);
console.log(`  encomendas sem factura registada=${noInvoice}  normalize indisponível=${hostFail}`);
console.log(`  reembolsos que sairiam diferentes do código actual: ${wouldDifferFromToday}`);
if (refusals.size) {
  console.log(`\n  Recusas, por motivo:`);
  for (const [reason, n] of [...refusals].sort((a, b) => b[1] - a[1])) console.log(`    ${n} x ${reason}`);
}
if (overCredited.length) {
  console.log(`\n  Facturas já creditadas acima do seu total:`);
  for (const line of overCredited) console.log(`    ${line}`);
}
if (uncredited.length) {
  console.log(`\n  Reembolsos espelháveis cuja factura não tem nenhuma nota de crédito no IX (a rever):`);
  for (const line of uncredited) console.log(`    ${line}`);
}
if (duplicateRefs.length) {
  console.log(`\n  Facturas com notas de crédito repetidas (lista de limpeza):`);
  for (const line of duplicateRefs) console.log(`    ${line}`);
}
const clean = mirrored === exactness;
console.log(clean
  ? `\n  ✅ Nenhum espelho errado. Rever as recusas antes de deployar.`
  : `\n  ❌ ${mirrored - exactness} espelho(s) errado(s) — NÃO deployar.`);
