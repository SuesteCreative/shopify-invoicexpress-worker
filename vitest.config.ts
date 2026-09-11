import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Only the path alias. Everything else stays on vitest's defaults, which is how
 * the suite ran before this file existed.
 *
 * The backoffice is a Next app and its modules import each other as `@/lib/x`;
 * without this, any test touching one of them fails to resolve before it runs a
 * single assertion. The worker's own tests use relative imports and are
 * untouched by this.
 */
export default defineConfig({
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./backoffice/src", import.meta.url)),
        },
    },
});
