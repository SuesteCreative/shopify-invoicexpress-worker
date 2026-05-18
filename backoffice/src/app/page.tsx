import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import Landing from "@/components/landing/Landing";
import { editorialSerif, sansDisplay, monoFont } from "./fonts";

export const runtime = "edge";

export default async function LandingPage() {
  const { userId } = await auth();

  if (userId) {
    redirect("/dashboard");
  }

  return (
    <div
      className={`${editorialSerif.variable} ${sansDisplay.variable} ${monoFont.variable}`}
      style={{ fontFamily: "var(--font-sans-display), system-ui, sans-serif" }}
    >
      <Landing />
    </div>
  );
}
