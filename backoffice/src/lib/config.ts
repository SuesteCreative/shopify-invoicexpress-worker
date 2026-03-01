export const RIOKO_CONFIG = {
    version: "3.7.3",
    stableBuild: true,
    environment: "Production",
    workerUrl: "https://shopify-invoicexpress-worker.pedrotovarporto.workers.dev",
    webhookTopics: ["orders/paid", "refunds/create"]
};
