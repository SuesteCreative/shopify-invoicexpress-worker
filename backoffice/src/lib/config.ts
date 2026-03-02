export const RIOKO_CONFIG = {
    version: "4.1.4",
    stableBuild: true,
    environment: "Production",
    workerUrl: "https://shopify-invoicexpress-worker.pedrotovarporto.workers.dev",
    webhookTopics: ["orders/paid", "refunds/create"]
};
