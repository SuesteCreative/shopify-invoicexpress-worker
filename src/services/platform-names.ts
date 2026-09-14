/**
 * How the platforms are spelled to a human.
 *
 * The kinds are internal identifiers — `invoicexpress`, `stripe_connect` — and
 * the thirty-odd places that raise an incident label the connection with them
 * directly (`connection_label: "lodgify → moloni"`). That string is printed
 * verbatim in the chip under an alert's title, which is why the emails have
 * been announcing themselves in lowercase snake_case. Prettifying happens here,
 * at the one place that renders it, rather than in thirty call sites.
 */
export const PLATFORM_NAMES: Record<string, string> = {
  // Sources
  shopify: "Shopify",
  stripe: "Stripe",
  stripe_connect: "Stripe Connect",
  lodgify: "Lodgify",
  eupago: "EuPago",
  // Destinations
  invoicexpress: "InvoiceXpress",
  moloni: "Moloni",
  vendus: "Vendus",
};

/** "lodgify → moloni" → "Lodgify → Moloni". An unrecognised token is left
 *  exactly as the caller wrote it — a label we cannot spell is still better
 *  than one we mangle. */
export function prettyConnectionLabel(label: string | undefined): string | undefined {
  if (!label) return label;
  return label
    .split("→")
    .map((part) => {
      const t = part.trim();
      return PLATFORM_NAMES[t.toLowerCase()] ?? t;
    })
    .join(" → ");
}

/**
 * The pipes an account actually has into one destination, as one chip:
 * "Shopify · Stripe → InvoiceXpress".
 *
 * For an email about the destination rather than about one sale — an
 * InvoiceXpress plan limit is hit by the account, not by a connection — where
 * naming a single source would be a guess. Undefined when the caller found no
 * source at all, so the chip is left out rather than invented.
 */
export function connectionPill(sources: string[], destination: string): string | undefined {
  const named = [...new Set(sources.map((s) => s.trim()).filter(Boolean))]
    .map((s) => PLATFORM_NAMES[s.toLowerCase()] ?? s);
  if (named.length === 0) return undefined;
  return `${named.join(" · ")} → ${PLATFORM_NAMES[destination.toLowerCase()] ?? destination}`;
}
