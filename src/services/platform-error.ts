/**
 * The destination's own HTTP status, carried on the thrown Error.
 *
 * Every emission failure already travels as an Error whose message embeds the
 * platform's response body, and the triage prompt asks the model to tell a
 * permanent 4xx from a transient 5xx from an expired token. It could not: the
 * status was read by nobody. The IX SDK hands back `{ data, error, response }`
 * and every call site destructured the first two, so the one field that answers
 * "will retrying help?" was dropped at the source and reconstructed nowhere.
 *
 * Attaching it to the Error keeps it travelling with the failure through the
 * queue consumer and into the incident detail, where redactIncident can hand it
 * to the model as a number instead of hoping it appears inside free text.
 *
 * Deliberately NOT recovered by scanning the message for a 3-digit number: the
 * embedded response bodies are full of amounts and ids, and a total of 500.00€
 * reads as a server error to a regex. A wrong status is worse than none here —
 * the model is told to trust it — so it is set only where it is known.
 */
export interface PlatformError extends Error {
  http_status?: number;
}

/** Throwable Error carrying the destination's HTTP status, when we know it. */
export function platformError(message: string, status?: number | null): PlatformError {
  const err = new Error(message) as PlatformError;
  if (typeof status === "number" && status > 0) err.http_status = status;
  return err;
}

/** The status off an unknown caught value, or undefined when it never carried one. */
export function httpStatusOf(err: unknown): number | undefined {
  const status = (err as PlatformError)?.http_status;
  return typeof status === "number" && status > 0 ? status : undefined;
}
