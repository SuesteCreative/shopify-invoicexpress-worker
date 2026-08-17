import { auth } from "@clerk/nextjs/server";
import { isAdmin } from "@/lib/admin";
import { redirect } from "next/navigation";
import { OpsPanel } from "./OpsPanel";

export const runtime = "edge";
export const dynamic = "force-dynamic";

export default async function OpsPage() {
  const { userId } = await auth();
  if (!userId || !(await isAdmin(userId))) {
    redirect("/dashboard");
  }
  return <OpsPanel />;
}
