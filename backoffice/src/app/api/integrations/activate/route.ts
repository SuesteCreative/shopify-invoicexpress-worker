import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

export const runtime = "edge";

/**
 * Retired. This route used to create the four Shopify webhooks through the Admin
 * API, and doing so is wrong on this platform.
 *
 * Webhooks here are created by hand in the store's Settings → Notifications, per
 * the onboarding guide, and are owned by the STORE. A webhook created through
 * the Admin API is owned by the APP instead, and Shopify signs the two with
 * different secrets: the store's is the "Your webhooks will be signed with…"
 * value the integrator copies into Rioko, while the app's is its own client
 * secret, which Rioko never sees.
 *
 * So this route did not repair anything. It added a SECOND set of subscriptions
 * on top of the working manual ones, and every delivery from that second set
 * failed HMAC verification. Soul Krave and Estrela Jewelry Studio were left that
 * way on 2026-05-21 and produced roughly 6,500 `webhook_invalid_signature`
 * incidents between them before anyone connected the two — the orders themselves
 * kept being invoiced normally through the manual subscriptions, which is
 * precisely why it stayed invisible for three months.
 *
 * Note that the access tokens are issued WITHOUT `write_webhooks`, and that did
 * not stop any of it: an app may always manage its own subscriptions, so the
 * missing scope was never the guard it was assumed to be.
 *
 * Refusing on the server rather than only hiding the button: a client that still
 * calls this — an old tab, a bookmarked flow — must not be able to recreate the
 * problem. The correct step is POST /api/integrations/webhooks-confirm, which
 * records that the manual installation was done.
 */
export async function POST() {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  return NextResponse.json(
    {
      error: "Webhook installation via API is disabled",
      reason:
        "Os webhooks desta plataforma são criados à mão em Settings → Notifications da loja. "
        + "Criá-los pela Admin API gera um segundo conjunto, assinado com um segredo diferente, "
        + "cujas entregas são todas rejeitadas por assinatura inválida.",
      next_step: "Instalar os 4 webhooks manualmente e depois usar \"Confirmar Instalação Manual\".",
      guide: "/pt/onboarding-helper",
    },
    { status: 410 },
  );
}
