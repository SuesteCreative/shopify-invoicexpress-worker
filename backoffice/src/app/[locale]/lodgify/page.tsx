import type { Metadata } from "next";
import { VERTICALS } from "@/components/landing/vertical-config";
import { VerticalPage, verticalMetadata } from "@/components/landing/vertical-page";

export const runtime = "edge";

const VARIANT = VERTICALS.lodgify;

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { locale } = await params;
    return verticalMetadata(VARIANT, locale);
}

export default async function Page({ params }: Props) {
    const { locale } = await params;
    return VerticalPage({ variant: VARIANT, locale });
}
