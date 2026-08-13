/**
 * InvoiceXpress date plumbing.
 *
 * IX speaks dd/mm/yyyy on the wire and we reason in ISO yyyy-mm-dd everywhere
 * else, so every read has to be parsed and every write formatted. Getting this
 * wrong is not a display bug: a document's date decides which fiscal period it
 * lands in, and IX rejects a finalize whose date falls behind the series.
 */

/** IX (dd/mm/yyyy) or ISO input → ISO yyyy-mm-dd. Null when unparseable. */
export function parseIxDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

/** ISO yyyy-mm-dd → the dd/mm/yyyy IX expects. */
export function formatPtDate(isoYmd: string): string {
  const [y, m, d] = isoYmd.split("-");
  return `${d}/${m}/${y}`;
}

export function todayUtcYmd(): string {
  return new Date().toISOString().slice(0, 10);
}
