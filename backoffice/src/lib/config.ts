export const WEBHOOK_TOPICS_BY_SOURCE = {
    shopify: ["orders/paid", "refunds/create"] as string[],
    stripe: ["charge.succeeded", "charge.refunded", "invoice.paid"] as string[],
};

export const RIOKO_CONFIG = {
    version: "4.1.8",
    stableBuild: true,
    environment: "Production",
    workerUrl: "https://shopify-invoicexpress-worker.pedrotovarporto.workers.dev",
    // Back-compat: default export remains Shopify topics for existing callers
    // (the activate route uses these to install Shopify webhooks). New code
    // should reference WEBHOOK_TOPICS_BY_SOURCE directly.
    webhookTopics: ["orders/paid", "refunds/create"],
};
