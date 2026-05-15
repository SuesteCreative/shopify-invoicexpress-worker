export interface ScoreInput {
  amount: number;
  date: string;
  customerName?: string | null;
  reference?: string | null;
}

export interface ScoreCandidate {
  amount: number;
  date: string;
  clientName?: string | null;
  reference?: string | null;
}

const tokenize = (s: string) =>
  new Set(
    s.toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length >= 2)
  );

const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
};

const daysBetween = (a: string, b: string): number => {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (isNaN(ta) || isNaN(tb)) return 999;
  return Math.abs(ta - tb) / (1000 * 60 * 60 * 24);
};

export function scoreHeuristicMatch(order: ScoreInput, invoice: ScoreCandidate): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  const diff = Math.abs(order.amount - invoice.amount);
  if (diff < 0.01) {
    score += 40;
    reasons.push(`valor €${order.amount.toFixed(2)}`);
  } else {
    const pct = order.amount === 0 ? 1 : diff / Math.abs(order.amount);
    if (pct <= 0.1) {
      score += Math.round(40 * (1 - pct / 0.1));
      reasons.push(`valor próximo`);
    }
  }

  const days = daysBetween(order.date, invoice.date);
  if (days <= 2) {
    score += 20;
    reasons.push("data próxima");
  } else if (days <= 5) {
    score += Math.round(20 * (1 - (days - 2) / 3));
  }

  if (order.customerName && invoice.clientName) {
    const sim = jaccard(tokenize(order.customerName), tokenize(invoice.clientName));
    if (sim > 0) {
      score += Math.round(30 * sim);
      if (sim >= 0.3) reasons.push(`cliente ${invoice.clientName}`);
    }
  }

  if (order.reference && invoice.reference) {
    if (invoice.reference.includes(order.reference)) {
      score += 10;
      reasons.push("ref. encontrada");
    }
  }

  return { score: Math.min(score, 99), reasons };
}
