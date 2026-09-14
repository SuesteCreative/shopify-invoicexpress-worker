import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";

import { isHiperadmin } from "@/lib/admin";
import { resolveClientCode } from "@/lib/client-code";
import { createAccountPost, deleteAccountPost, listAccountPosts } from "@/lib/account-posts";

export const runtime = "edge";

/**
 * A company's wall — post, read, hide.
 *
 * Its own route rather than another shape on the record's PATCH: posting is a
 * create and hiding is a delete, and bending both into "PATCH a field" is how
 * that handler ends up dispatching on five different body shapes.
 *
 * Hiperadmin on every verb, like the rest of the fiscal block this sits under.
 * A wall says what a company was told, agreed and asked for, which is the same
 * class of knowledge as the configuration beside it.
 */

async function target(request: NextRequest, ctx: { params: Promise<{ code: string }> }) {
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

export async function GET(request: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  try {
    const t = await target(request, ctx);
    if ("error" in t) return t.error;
    return NextResponse.json({ posts: await listAccountPosts(t.db, t.accountId) });
  } catch (error: any) {
    console.error("[admin/clientes/posts] GET failed:", error?.message ?? error);
    return NextResponse.json({ error: "read_failed" }, { status: 500 });
  }
}

export async function POST(request: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  try {
    const t = await target(request, ctx);
    if ("error" in t) return t.error;

    const body = await request.json().catch(() => ({})) as { body?: string };
    const created = await createAccountPost(t.db, {
      accountId: t.accountId, author: t.userId, body: String(body.body ?? ""),
    });
    if ("error" in created) return NextResponse.json({ error: created.error }, { status: 400 });

    // The whole feed, so the caller renders the new post in its place without a
    // second request and without guessing where the server put it.
    return NextResponse.json({ id: created.id, posts: await listAccountPosts(t.db, t.accountId) });
  } catch (error: any) {
    console.error("[admin/clientes/posts] POST failed:", error?.message ?? error);
    return NextResponse.json({ error: "write_failed" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  try {
    const t = await target(request, ctx);
    if ("error" in t) return t.error;

    const postId = new URL(request.url).searchParams.get("id");
    if (!postId) return NextResponse.json({ error: "id required" }, { status: 400 });

    // Scoped to this company: a post id from another account answers 404 rather
    // than confirming that it exists.
    const hidden = await deleteAccountPost(t.db, { accountId: t.accountId, actor: t.userId, postId }, t.env);
    if (!hidden) return NextResponse.json({ error: "not_found" }, { status: 404 });

    return NextResponse.json({ posts: await listAccountPosts(t.db, t.accountId) });
  } catch (error: any) {
    console.error("[admin/clientes/posts] DELETE failed:", error?.message ?? error);
    return NextResponse.json({ error: "write_failed" }, { status: 500 });
  }
}
