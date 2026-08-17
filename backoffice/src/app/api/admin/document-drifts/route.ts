import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";
import { callWorkerJson } from "@/lib/worker";

export const runtime = "edge";

/**
 * Everything that came out different from what we sent, plus the refusals.
 *
 * The worker has exposed this since the document log landed and nothing has ever
 * called it, so the one feed that answers "what went wrong today" was reachable
 * only by curl with an admin key.
 */
export async function GET(request: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!await isAdmin(userId)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const params = request.nextUrl.searchParams;
  const days = Math.min(Math.max(parseInt(params.get("days") ?? "7", 10) || 7, 1), 90);
  const targetUser = params.get("user_id");

  const qs = new URLSearchParams({ days: String(days) });
  if (targetUser) qs.set("user_id", targetUser);

  const { ok, status, data } = await callWorkerJson(`/admin/document-drifts?${qs.toString()}`);
  return NextResponse.json(data, { status: ok ? 200 : status });
}
