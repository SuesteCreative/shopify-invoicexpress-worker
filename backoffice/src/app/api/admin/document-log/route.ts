import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";
import { callWorkerJson } from "@/lib/worker";

export const runtime = "edge";

/**
 * One sale's whole story, for the ops view — or one client's, for their record.
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

  const params = request.nextUrl.searchParams;
  const externalId = params.get("external_id");
  const targetUserId = params.get("user_id");
  const limit = params.get("limit");
  if (!externalId && !targetUserId) {
    return NextResponse.json({ error: "external_id or user_id required" }, { status: 400 });
  }

  const query = new URLSearchParams();
  if (externalId) query.set("external_id", externalId);
  else if (targetUserId) query.set("user_id", targetUserId);
  if (limit) query.set("limit", limit);

  const { ok, status, data } = await callWorkerJson(`/admin/document-log?${query.toString()}`);
  return NextResponse.json(data, { status: ok ? 200 : status });
}
