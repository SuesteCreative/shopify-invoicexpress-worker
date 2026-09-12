import type { Env } from "../env";
import { reportIncident } from "../services/incidents";

/**
 * Cloudflare Workers Builds event subscription — the alarm for "main stopped
 * reaching production".
 *
 * On 2026-09-11 a build started failing and the worker quietly kept serving
 * the previous version for twelve hours and 41 commits. Nothing said so: the
 * GitHub CI went red 38 times and nobody reads it, and the backoffice deploys
 * through Pages on a separate path that never broke, so the product looked
 * healthy throughout. The only honest signal was a dashboard page.
 *
 * Cloudflare publishes build.failed / build.canceled to `worker-build-events`;
 * this turns them into the incident email that is already read.
 */

/** The slice of the Workers Builds payload we actually rely on. */
interface BuildEvent {
    buildUuid?: string;
    status?: string;
    buildOutcome?: string | null;
    buildTriggerMetadata?: {
        branch?: string;
        commitHash?: string;
        author?: string;
        repoName?: string;
    };
}

export async function processBuildEventBatch(batch: MessageBatch<BuildEvent>, env: Env): Promise<void> {
    for (const message of batch.messages) {
        try {
            const e = message.body ?? {};
            const outcome = e.buildOutcome ?? e.status ?? "unknown";

            // Subscribed to failures only, but a redelivered or reshaped event
            // must never page anyone about a build that actually worked.
            if (outcome === "success") {
                message.ack();
                continue;
            }

            const meta = e.buildTriggerMetadata ?? {};
            const commit = meta.commitHash ?? null;
            const branch = meta.branch ?? null;

            await reportIncident(env, {
                severity: "critical",
                kind: "worker_build_failed",
                summary: `O build do worker terminou em "${outcome}"${branch ? ` em ${branch}` : ""}${commit ? ` (${commit.slice(0, 7)})` : ""}. Produção continua na versão anterior até um build passar.`,
                detail: { outcome, branch, commit, author: meta.author ?? null, buildUuid: e.buildUuid ?? null },
                affected_ids: commit ? [commit.slice(0, 7)] : [],
                // Daily, not hourly: a broken build fails again on every push,
                // and ten pushes in an afternoon is one problem, not ten.
                bucket: "daily",
                connection_label: "Cloudflare → worker",
            });
        } catch (err) {
            console.error("[BuildEvents] Failed to report a build failure:", err);
        }
        // Always ack. A retry would only re-report something already reported,
        // and the incident is the record — losing one is better than a loop.
        message.ack();
    }
}
