import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isHiperadmin } from "@/lib/admin";
import { callWorkerJson } from "@/lib/worker";

export const runtime = "edge";

/**
 * The notice a blocked merchant gets: their invoicing is stopped, and here is
 * where to subscribe.
 *
 * The worker has owned this since it was written — it is where Resend lives and
 * where the pending-order count is verified against the incidents. What it never
 * had was a way to run it: whoever sent the last batch on 08/09 did it by hand,
 * with curl and the admin key, and a job that can only be run that way is a job
 * that gets run at the wrong moment or not at all.
 *
 * Dry run unless told otherwise, twice over: this route defaults to it and so
 * does the worker. The email says "N faturas por emitir" with a verified count,
 * so a dry run is also the only way to see what each merchant would actually be
 * told before they are told it.
 */
export async function POST(request: NextRequest) {
    try {
        const { userId } = await auth();
        // Writing to clients is hiperadmin work, as deleting their data is.
        if (!userId || !(await isHiperadmin(userId))) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await request.json().catch(() => ({})) as {
            confirm?: boolean;
            user_id?: string;
            resend_after_days?: number;
        };

        const { ok, status, data } = await callWorkerJson("/admin/billing/paused-notices", {
            method: "POST",
            body: JSON.stringify({
                dry_run: body.confirm !== true,
                user_id: body.user_id,
                // Left to the worker's own default (7 days) unless an operator
                // deliberately shortens it. Three days after the last batch is a
                // nag, and the marker exists to make that a decision rather than
                // an accident.
                ...(typeof body.resend_after_days === "number"
                    ? { resend_after_days: body.resend_after_days }
                    : {}),
            }),
        });

        if (!ok) {
            console.error(`[admin/dunning] worker ${status}:`, JSON.stringify(data));
            return NextResponse.json({ error: "worker_failed", status }, { status: 502 });
        }

        console.warn(
            `[admin/dunning] ${body.confirm === true ? "SENT" : "dry run"} by ${userId}`,
        );
        return NextResponse.json(data);
    } catch (error: any) {
        console.error("[admin/dunning] failed:", error?.message ?? error);
        return NextResponse.json({ error: "dunning_failed" }, { status: 500 });
    }
}
