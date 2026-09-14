export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sleeps to give the orders/created webhook a chance to complete and persist
 * an `invoice_id` in processed_orders before orders/paid tries to finalize it.
 *
 * Race: Shopify can fire orders/created and orders/paid milliseconds apart.
 * The created queue message already has a 120s ingress delay (see enqueueWebhook
 * in index.ts), so this 15s pad covers the tail of that handler actually writing
 * the invoice row. If invoice still not found after this delay, the paid handler
 * throws and the queue retries with another 360s backoff.
 */
export function awaitInvoiceVisibility(): Promise<void> {
  return delay(15000);
}

/**
 * The fields of an object that actually say something — for merging layers.
 *
 * Object spread overwrites on key PRESENCE, not on usefulness, so a layer that
 * is present and blank erases one that carried real data. Every Stripe shape
 * builds its customer addresses from `emptyAddress()`, where each field is `""`
 * rather than absent, and both invoice-address merges spread such a layer late.
 *
 * Measured on Bestisafil (14/09/2026): InvoiceXpress document 270275892 went out
 * as "1269-046 Lisboa" with no street, while the charge held "Av. da Liberdade
 * nº 110" — `address1: ""` from the last layer had overwritten it. The zip had
 * already been given a hand-written workaround for the same reason and the city
 * escaped by never going through the merge; the street had neither, and each new
 * field would have needed its own patch.
 *
 * Filtering blanks instead of reordering layers keeps every precedence that
 * means something: a layer still wins where its values are real, and only stops
 * winning where it has nothing to say.
 */
export function presentFields<T extends object>(layer: T | null | undefined): Partial<T> {
  if (!layer) return {};
  return Object.fromEntries(
    Object.entries(layer).filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== ""),
  ) as Partial<T>;
}
