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
