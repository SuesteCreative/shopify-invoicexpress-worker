import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";
import { callWorkerJson } from "@/lib/worker";

export const runtime = "edge";

/**
 * One sale's whole story, for the ops view.
 *
 * A thin proxy rather than a direct D1 read: the worker already owns the
 * timeline's shape (event labels, retention tiers, detail truncation), and a
 * second implementation here would drift from it silently — which is the exact
 * failure the document log exists to end.
 */
export async function GET(request: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!await isAdmin(userId)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const externalId = request.nextUrl.searchParams.get("external_id");
  if (!externalId) return NextResponse.json({ error: "external_id required" }, { status: 400 });

  const { ok, status, data } = await callWorkerJson(
    `/admin/document-log?external_id=${encodeURIComponent(externalId)}`,
  );
  return NextResponse.json(data, { status: ok ? 200 : status });
}
