import { auth } from "@clerk/nextjs/server";
import { setRequestLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";
import Landing from "@/components/landing/Landing";
import { sansDisplay, monoFont } from "../fonts";

export const runtime = "edge";

export default async function LandingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const { userId } = await auth();

  if (userId) {
    redirect({ href: "/dashboard", locale });
  }

  return (
    <div
      className={`${sansDisplay.variable} ${monoFont.variable}`}
      style={{ fontFamily: "var(--font-sans-display), system-ui, sans-serif" }}
    >
      <Landing />
    </div>
  );
}
