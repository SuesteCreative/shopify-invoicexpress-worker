import { SignUp } from "@clerk/nextjs";

export const runtime = "edge";

export default async function Page({
    params,
}: {
    params: Promise<{ locale: string }>;
}) {
    const { locale } = await params;
    return (
        <div className="flex items-center justify-center min-h-screen bg-slate-950">
            <SignUp
                path={`/${locale}/sign-up`}
                signInUrl={`/${locale}/sign-in`}
                forceRedirectUrl={`/${locale}/dashboard`}
            />
        </div>
    );
}
