import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";
import { callWorkerJson } from "@/lib/worker";

export const runtime = "edge";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { userId } = await auth();
    if (!userId || !(await isAdmin(userId))) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { id } = await params;
    const body = await request.json() as { disposition: "approve" | "reject" };
    if (body.disposition !== "approve" && body.disposition !== "reject") {
        return NextResponse.json({ error: "disposition must be 'approve' or 'reject'" }, { status: 400 });
    }

    const { ok, status, data } = await callWorkerJson(
        `/admin/pending-reverse-charge/${encodeURIComponent(id)}/${body.disposition}`,
        { method: "POST" },
    );
    return NextResponse.json(data, { status: ok ? 200 : status });
}
