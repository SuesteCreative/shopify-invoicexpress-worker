// Advisory AI incident triage. Reads an incident's TECHNICAL data and asks Claude
// for an order-specific diagnosis + suggested fix, which is rendered (clearly
// labelled) into the ops alert email. This layer is STRICTLY ADVISORY: it never
// computes an invoice value, never changes a fiscal document, and FAILS OPEN —
// any error/timeout/missing-key returns null and the email sends exactly as before.
//
// Consumer-data protection: `redactIncident` is a WHITELIST. Only tax/total math,
// SKU/product names, vendor error text and connection metadata leave the worker.
// Client name, email, NIF/fiscal_id, order ref, user_id are never sent. Anthropic
// does not train on API data by default; request Zero-Data-Retention for more.

import type { Env } from "../env";
import type { ReportIncidentInput } from "./incidents";
import { ixCall } from "../ix/ix-call";
import { RIOKO_DOMAIN_KNOWLEDGE } from "./triage-knowledge";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1024; // room for a full PT diagnosis + all 4 tool fields (512 truncated mid-object)
const TIMEOUT_MS = 20000; // Sonnet + the full cached knowledge prompt; first call also pays cache-creation latency
const DIAG_TTL = 86400; // 24h KV cache for a computed diagnosis
const CAP_TTL = 3600; // hourly counter window
const DEFAULT_HOURLY_CAP = 40;
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export interface IncidentDiagnosis {
  diagnosis: string;
  suggested_fix: string;
  confidence: "high" | "medium" | "low";
  is_actionable: boolean;
}

export interface RedactedLine {
  name?: string;
  quantity?: number;
  unit_price?: number;
  tax_rate?: number;
  discount_percent?: number;
}

// Whitelist-only view of an incident — the ONLY thing that leaves the worker.
export interface RedactedIncident {
  kind: string;
  connection_label?: string;
  source?: string;
  destination?: string;
  currency?: string;
  error_message?: string;
  totals?: { paid?: number; expected?: number; drift?: number };
  lines?: RedactedLine[];
}

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const NINE_DIGIT_RE = /\b\d{9}\b/g; // PT NIF shape — scrub from free-text vendor errors

// Strip PII that a free-form vendor error string might echo, then truncate.
function scrubMessage(msg: string, extra: Array<string | undefined>): string {
  let out = String(msg);
  for (const s of extra) {
    if (s && s.length >= 3) out = out.split(s).join("«redacted»");
  }
  return out.replace(EMAIL_RE, "«email»").replace(NINE_DIGIT_RE, "«nif»").slice(0, 1500);
}

// Parse "paid=.. expected=.. drift=.." and the JSON `Lines=[...]` out of a
// reconcile_drift message. The line objects carry only product-level math
// (name/qty/unit_price/tax_rate/discount_percent) — no customer data.
function parseReconcile(message: string): { totals?: RedactedIncident["totals"]; lines?: RedactedLine[] } {
  const out: { totals?: RedactedIncident["totals"]; lines?: RedactedLine[] } = {};
  const m = /paid=(\d+(?:\.\d+)?)\s+expected=(\d+(?:\.\d+)?)\s+drift=(\d+(?:\.\d+)?)/.exec(message);
  if (m) out.totals = { paid: Number(m[1]), expected: Number(m[2]), drift: Number(m[3]) };
  const idx = message.indexOf("Lines=");
  if (idx !== -1) {
    const arrText = message.slice(idx + "Lines=".length).trim();
    try {
      const parsed = JSON.parse(arrText);
      if (Array.isArray(parsed)) {
        out.lines = parsed.map((l: any) => ({
          name: typeof l?.name === "string" ? l.name.slice(0, 120) : undefined,
          quantity: Number(l?.quantity) || undefined,
          unit_price: Number(l?.unit_price) || undefined,
          tax_rate: l?.tax_rate != null ? Number(l.tax_rate) : undefined,
          discount_percent: l?.discount_percent != null ? Number(l.discount_percent) : undefined,
        }));
      }
    } catch { /* malformed Lines — totals (if any) still useful */ }
  }
  return out;
}

/** Whitelist redaction. Returns ONLY the technical fields safe to send. */
export function redactIncident(input: ReportIncidentInput): RedactedIncident {
  const detail = (input.detail ?? {}) as any;
  const rawMessage = typeof detail.message === "string" ? detail.message : "";
  const red: RedactedIncident = {
    kind: input.kind,
    connection_label: input.connection_label,
    source: typeof detail.source === "string" ? detail.source : undefined,
    destination: typeof detail.destination === "string" ? detail.destination : undefined,
    currency: typeof detail.currency === "string" ? detail.currency : undefined,
  };
  if (input.kind === "reconcile_drift" && rawMessage) {
    const { totals, lines } = parseReconcile(rawMessage);
    red.totals = totals;
    red.lines = lines;
    // Keep only the human-readable prefix before the Lines blob (no PII there).
    const cut = rawMessage.indexOf(". Lines=");
    red.error_message = scrubMessage(cut !== -1 ? rawMessage.slice(0, cut) : rawMessage, [input.client_name, input.order_ref]);
  } else if (rawMessage) {
    red.error_message = scrubMessage(rawMessage, [input.client_name, input.order_ref]);
  }
  return red;
}

const SYSTEM_PROMPT = `És um engenheiro de fiabilidade especializado em faturação fiscal portuguesa.
Analisas UM incidente do Rioko e produzes um diagnóstico técnico curto + uma correção concreta.

${RIOKO_DOMAIN_KNOWLEDGE}

## Como diagnosticar por tipo (kind)
- reconcile_drift: usa totals (paid/expected/drift) + as linhas e a regra do IVA incluído/effectiveRate;
  nomeia o SKU em causa e a correção (override tax_rate/vat_inclusion ou definição de impostos da loja).
- destination_reject / queue_retry_exhausted: interpreta error_message — permanente (4xx) vs transitório
  (5xx/502/timeout) vs autenticação (401/token).
- nif_invalid: o NIF não validou — confirmar com o cliente ou tratar como estrangeiro.
- currency_not_supported: moeda ≠ EUR.

## Regras de saída
- Responde SEMPRE chamando a ferramenta report_diagnosis.
- Português europeu, conciso: diagnóstico em 2-3 frases + 1 correção concreta e acionável.
- Usa APENAS os dados técnicos fornecidos. Não inventes valores, SKUs nem clientes. Se faltar
  informação, di-lo e baixa a confiança.
- És ADVISÓRIO. Nunca afirmes que algo foi corrigido nem dês instruções que alterem um documento
  fiscal já emitido.`;

const DIAGNOSIS_TOOL = {
  name: "report_diagnosis",
  description: "Reporta o diagnóstico técnico e a correção sugerida para um incidente de faturação.",
  input_schema: {
    type: "object",
    properties: {
      diagnosis: { type: "string", description: "2-3 frases, português europeu, sobre a causa técnica provável." },
      suggested_fix: { type: "string", description: "Uma ação concreta e acionável para o operador." },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      is_actionable: { type: "boolean", description: "true se o operador pode agir já; false se é apenas informativo." },
    },
    required: ["diagnosis", "suggested_fix", "confidence", "is_actionable"],
  },
} as const;

function capKey(): string {
  return `llm:cap:${new Date().toISOString().slice(0, 13)}`; // per UTC hour
}

export interface IncidentPattern {
  title: string;
  detail: string;
  affected_count?: number;
  suggested_action: string;
}
export interface PatternReport {
  summary: string;
  patterns: IncidentPattern[];
}

const PATTERN_SYSTEM_PROMPT = `És um engenheiro de fiabilidade do Rioko. Recebes uma lista de incidentes
técnicos da última semana (já sem dados pessoais) e identificas PADRÕES sistémicos — não repetes
incidentes um a um.

${RIOKO_DOMAIN_KNOWLEDGE}

Procura causas-raiz partilhadas (vários comerciantes com o mesmo erro de IVA incluído/excluído ou
force_tax_rate; picos de destination_reject por timeout de um destino; séries de NIF inválido),
agrupando por causa provável, com uma ação concreta por padrão.

Regras: responde SEMPRE via report_patterns. Português europeu, conciso. Usa apenas os dados dados;
não inventes. És advisório.`;

const PATTERN_TOOL = {
  name: "report_patterns",
  description: "Reporta padrões sistémicos identificados na semana de incidentes.",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "1-2 frases de visão geral da semana." },
      patterns: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            detail: { type: "string", description: "Causa provável partilhada, em 1-2 frases." },
            affected_count: { type: "number", description: "Nº aproximado de incidentes neste padrão." },
            suggested_action: { type: "string" },
          },
          required: ["title", "detail", "suggested_action"],
        },
      },
    },
    required: ["summary", "patterns"],
  },
} as const;

/**
 * Weekly cross-incident pattern report (Phase 3). Single Sonnet call over the
 * redacted week. Returns null on any failure / disabled / empty input.
 */
export async function summarizeIncidentPatterns(
  env: Env,
  items: RedactedIncident[],
): Promise<PatternReport | null> {
  if (!env.ANTHROPIC_API_KEY || items.length === 0) return null;
  const model = env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
  const body = JSON.stringify({
    model,
    max_tokens: 1500,
    ...(model.includes("haiku") ? {} : { output_config: { effort: "low" } }),
    system: [{ type: "text", text: PATTERN_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    tools: [PATTERN_TOOL],
    tool_choice: { type: "tool", name: "report_patterns" },
    messages: [
      {
        role: "user",
        content: "Incidentes da semana (JSON técnico, sem dados pessoais):\n```json\n" + JSON.stringify(items) + "\n```",
      },
    ],
  });

  try {
    const res = await ixCall(
      () =>
        fetch(ANTHROPIC_URL, {
          method: "POST",
          headers: {
            "x-api-key": env.ANTHROPIC_API_KEY!,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body,
        }),
      { attempts: 2, timeoutMs: 20000, isOk: (r) => r.ok, label: "anthropic-patterns" },
    );
    if (!res.ok) { console.warn(`[anthropic] pattern report non-200: ${res.status}`); return null; }
    const json: any = await res.json();
    const block = Array.isArray(json?.content)
      ? json.content.find((b: any) => b?.type === "tool_use" && b?.name === "report_patterns")
      : null;
    const input = block?.input;
    if (input && typeof input.summary === "string" && Array.isArray(input.patterns)) {
      return {
        summary: input.summary.trim(),
        patterns: input.patterns
          .filter((p: any) => p && typeof p.title === "string")
          .map((p: any) => ({
            title: String(p.title),
            detail: String(p.detail ?? ""),
            affected_count: typeof p.affected_count === "number" ? p.affected_count : undefined,
            suggested_action: String(p.suggested_action ?? ""),
          })),
      };
    }
    return null;
  } catch (e: any) {
    console.warn(`[anthropic] pattern report failed (advisory, ignored): ${e?.message ?? e}`);
    return null;
  }
}

/**
 * Advisory diagnosis for an incident. Returns null on ANY failure (missing key,
 * cap, timeout, non-200, unparseable) so the caller renders the email as today.
 * `cacheKey` should be the incident bucket_key so retries / same-bucket
 * re-occurrences reuse one diagnosis (one paid call per user:kind:hour).
 */
export async function diagnoseIncident(
  env: Env,
  redacted: RedactedIncident,
  cacheKey: string,
): Promise<IncidentDiagnosis | null> {
  if (!env.ANTHROPIC_API_KEY) return null;
  const kv = env.INVOICE_KV;
  const diagKey = `llm:diag:${cacheKey}`;

  // Reuse a cached diagnosis if present.
  try {
    const cached = await kv.get(diagKey, "json");
    if (cached && (cached as any).diagnosis) return cached as IncidentDiagnosis;
  } catch { /* cache miss / KV blip — continue */ }

  // Soft hourly circuit breaker (cost ceiling). Racy by design; a small overshoot is fine.
  try {
    const cap = Number(env.AI_TRIAGE_HOURLY_CAP ?? DEFAULT_HOURLY_CAP);
    const n = Number((await kv.get(capKey())) ?? "0");
    if (Number.isFinite(cap) && n >= cap) return null;
  } catch { /* ignore */ }

  const model = env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
  const body = JSON.stringify({
    model,
    max_tokens: MAX_TOKENS,
    // effort is GA on Sonnet/Opus but errors on Haiku — only send it off-Haiku.
    ...(model.includes("haiku") ? {} : { output_config: { effort: "low" } }),
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    tools: [DIAGNOSIS_TOOL],
    tool_choice: { type: "tool", name: "report_diagnosis" },
    messages: [
      {
        role: "user",
        content: "Incidente (JSON técnico, sem dados pessoais):\n```json\n" + JSON.stringify(redacted, null, 2) + "\n```",
      },
    ],
  });

  let res: Response;
  try {
    res = await ixCall(
      () =>
        fetch(ANTHROPIC_URL, {
          method: "POST",
          headers: {
            "x-api-key": env.ANTHROPIC_API_KEY!,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body,
        }),
      { attempts: 2, timeoutMs: TIMEOUT_MS, isOk: (r) => r.ok, label: "anthropic-diagnose" },
    );
  } catch (e: any) {
    console.warn(`[anthropic] triage call failed (advisory, ignored): ${e?.message ?? e}`);
    return null;
  }

  if (!res.ok) {
    console.warn(`[anthropic] triage non-200: ${res.status}`);
    return null;
  }

  let out: IncidentDiagnosis | null = null;
  try {
    const json: any = await res.json();
    const block = Array.isArray(json?.content)
      ? json.content.find((b: any) => b?.type === "tool_use" && b?.name === "report_diagnosis")
      : null;
    const input = block?.input; // already an object — never JSON.parse a tool_use input
    if (input && typeof input.diagnosis === "string" && input.diagnosis.trim()
      && typeof input.suggested_fix === "string") {
      out = {
        diagnosis: input.diagnosis.trim(),
        suggested_fix: input.suggested_fix.trim(),
        confidence: ["high", "medium", "low"].includes(input.confidence) ? input.confidence : "low",
        is_actionable: !!input.is_actionable,
      };
    }
  } catch (e: any) {
    console.warn(`[anthropic] triage parse failed (advisory, ignored): ${e?.message ?? e}`);
    return null;
  }
  if (!out) return null;

  // Cache the diagnosis + bump the hourly counter. Both best-effort.
  try { await kv.put(diagKey, JSON.stringify(out), { expirationTtl: DIAG_TTL }); } catch { /* ignore */ }
  try {
    const key = capKey();
    const n = Number((await kv.get(key)) ?? "0") + 1;
    await kv.put(key, String(n), { expirationTtl: CAP_TTL });
  } catch { /* ignore */ }

  return out;
}
