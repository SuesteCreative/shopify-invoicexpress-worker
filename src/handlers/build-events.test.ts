import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../env";

const reported: any[] = [];
vi.mock("../services/incidents", () => ({
    reportIncident: async (_env: Env, input: any) => { reported.push(input); },
}));

const { processBuildEventBatch } = await import("./build-events");

const msg = (body: any) => {
    const m: any = { body, acked: false };
    m.ack = () => { m.acked = true; };
    m.retry = () => { throw new Error("must not retry"); };
    return m;
};
const run = async (...bodies: any[]) => {
    const messages = bodies.map(msg);
    await processBuildEventBatch({ queue: "worker-build-events", messages } as any, {} as Env);
    return messages;
};

const failed = {
    buildUuid: "b-1",
    status: "failed",
    buildOutcome: "failure",
    buildTriggerMetadata: { branch: "main", commitHash: "48a627af675a8af3ed6bf4e75cbd8657d2bcc3ff", author: "Pedro" },
};

describe("Workers Builds failures become an incident", () => {
    beforeEach(() => { reported.length = 0; });

    it("reports a failed build as critical, naming the branch and the short commit", async () => {
        await run(failed);
        expect(reported).toHaveLength(1);
        expect(reported[0].kind).toBe("worker_build_failed");
        expect(reported[0].severity).toBe("critical");
        expect(reported[0].summary).toContain("main");
        expect(reported[0].summary).toContain("48a627a");
        expect(reported[0].detail.commit).toBe(failed.buildTriggerMetadata.commitHash);
    });

    it("groups daily, so ten pushes against a broken build are one email", async () => {
        await run(failed);
        expect(reported[0].bucket).toBe("daily");
    });

    it("stays silent on a success that reaches it anyway", async () => {
        await run({ ...failed, status: "success", buildOutcome: "success" });
        expect(reported).toHaveLength(0);
    });

    it("still reports when the build carries no trigger metadata at all", async () => {
        await run({ buildUuid: "b-2", buildOutcome: "canceled" });
        expect(reported).toHaveLength(1);
        expect(reported[0].summary).toContain("canceled");
        expect(reported[0].affected_ids).toEqual([]);
    });

    it("acks every message, including one whose reporting threw", async () => {
        const messages = await run(failed, null, { ...failed, buildUuid: "b-3" });
        expect(messages.every(m => m.acked)).toBe(true);
    });
});
