export const WEBHOOK_TOPICS_BY_SOURCE = {
    shopify: ["orders/paid", "refunds/create"] as string[],
    stripe: ["charge.succeeded", "charge.refunded", "invoice.paid"] as string[],
};

import { RIOKO_VERSION, RIOKO_STABLE_BUILD } from "./version";

export const RIOKO_CONFIG = {
    version: RIOKO_VERSION,
    stableBuild: RIOKO_STABLE_BUILD,
    environment: "Production",
    workerUrl: "https://shopify-invoicexpress-worker.pedrotovarporto.workers.dev",
    // Where the browser comes back to after an OAuth consent screen. Hardcoded
    // rather than derived from the request host because both Stripe and Moloni
    // match the redirect URI against a value registered in their console — a
    // preview deployment's URL would not match, and neither would localhost.
    appUrl: "https://rioko.online",
    // Back-compat: default export remains Shopify topics for existing callers
    // (the activate route uses these to install Shopify webhooks). New code
    // should reference WEBHOOK_TOPICS_BY_SOURCE directly.
    webhookTopics: ["orders/paid", "refunds/create"],
};

/**
 * Where a client's request for a human reaches one.
 *
 * A constant rather than an env var because it is the address already published
 * as Rioko's contact point (lib/schema.ts), and a support address that differs
 * between environments is a support address nobody answers.
 */
export const SUPPORT_EMAIL = "pedro@kapta.pt";
