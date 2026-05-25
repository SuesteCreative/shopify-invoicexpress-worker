import { SignIn } from "@clerk/nextjs";
import { LangToggle } from "@/components/landing/LangToggle";

export const runtime = "edge";

export default async function Page({
    params,
}: {
    params: Promise<{ locale: string }>;
}) {
    const { locale } = await params;
    return (
        <div className="flex flex-col items-center justify-center min-h-screen gap-6 bg-slate-950 p-4">
            <LangToggle variant="dark" />
            <SignIn
                path={`/${locale}/sign-in`}
                signUpUrl={`/${locale}/sign-up`}
                forceRedirectUrl={`/${locale}/dashboard`}
            />
        </div>
    );
}
