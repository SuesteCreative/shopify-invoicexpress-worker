import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";

import { isHiperadmin } from "@/lib/admin";
import { resolveClientCode } from "@/lib/client-code";
import { attachFileToPost, readPostFile, deletePostFile } from "@/lib/account-files";
import { safeFilename } from "@/lib/account-file-types";

export const runtime = "edge";

/**
 * Attachments on a company's wall.
 *
 * POST   multipart, one file, against an existing post
 * GET    ?id=…  streams the bytes back
 * DELETE ?id=…  removes the row AND the bytes
 *
 * Hiperadmin on every verb, and every lookup scoped to the company in the URL:
 * a file id from another client answers 404 rather than confirming it exists.
 */

async function target(ctx: { params: Promise<{ code: string }> }) {
  const { userId } = await auth();
  if (!userId || !(await isHiperadmin(userId))) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const { env } = getRequestContext();
  const db = (env as any).DB;
  if (!db) return { error: NextResponse.json({ error: "Database binding missing" }, { status: 500 }) };

  const { code } = await ctx.params;
  const resolved = await resolveClientCode(db, code);
  if (!resolved) return { error: NextResponse.json({ error: "not_found" }, { status: 404 }) };

  return { db, env, userId, accountId: resolved.accountId };
}

export async function POST(request: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  try {
    const t = await target(ctx);
    if ("error" in t) return t.error;

    const form = await request.formData();
    const postId = String(form.get("post_id") ?? "");
    const file = form.get("file");
    if (!postId) return NextResponse.json({ error: "post_id required" }, { status: 400 });
    if (!(file instanceof File)) return NextResponse.json({ error: "file required" }, { status: 400 });

    const out = await attachFileToPost(t.db, t.env, {
      accountId: t.accountId, postId, actor: t.userId, file,
    });
    if ("error" in out) {
      const status = out.error === "not_found" ? 404 : out.error === "blob_not_configured" ? 500 : 400;
      return NextResponse.json({ error: out.error }, { status });
    }
    return NextResponse.json({ id: out.id });
  } catch (error: any) {
    console.error("[admin/clientes/files] POST failed:", error?.message ?? error);
    return NextResponse.json({ error: "upload_failed" }, { status: 500 });
  }
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  try {
    const t = await target(ctx);
    if ("error" in t) return t.error;

    const fileId = new URL(request.url).searchParams.get("id");
    if (!fileId) return NextResponse.json({ error: "id required" }, { status: 400 });

    const found = await readPostFile(t.db, t.env, { accountId: t.accountId, fileId });
    if (!found) return NextResponse.json({ error: "not_found" }, { status: 404 });

    // What the browser is allowed to do with these bytes, decided here and not
    // by sniffing. `content_type` is what the upload VERIFIED the file to be, so
    // an image renders and everything else downloads; `nosniff` stops the
    // browser second-guessing either. The CSP is belt and braces for the one
    // case that would matter — a document that tried to fetch or script.
    const isImage = found.contentType.startsWith("image/");
    return new Response(found.stream, {
      headers: {
        "Content-Type": found.contentType,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Content-Disposition":
          `${isImage ? "inline" : "attachment"}; filename="${safeFilename(found.filename)}"`,
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (error: any) {
    console.error("[admin/clientes/files] GET failed:", error?.message ?? error);
    return NextResponse.json({ error: "read_failed" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  try {
    const t = await target(ctx);
    if ("error" in t) return t.error;

    const fileId = new URL(request.url).searchParams.get("id");
    if (!fileId) return NextResponse.json({ error: "id required" }, { status: 400 });

    const gone = await deletePostFile(t.db, t.env, { accountId: t.accountId, actor: t.userId, fileId });
    if (!gone) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("[admin/clientes/files] DELETE failed:", error?.message ?? error);
    return NextResponse.json({ error: "delete_failed" }, { status: 500 });
  }
}
