import { auth } from "@clerk/nextjs/server";
import { isAdmin } from "@/lib/admin";
import { redirect } from "next/navigation";
import { OnboardingHelperPanel } from "./OnboardingHelperPanel";

export const runtime = "edge";
export const dynamic = "force-dynamic";

export default async function OnboardingHelperPage() {
    const { userId } = await auth();
    if (!userId || !(await isAdmin(userId))) {
        redirect("/dashboard");
    }

    return <OnboardingHelperPanel />;
}
