import Script from "next/script";

/** The GA4 property every Rioko surface reports to. */
export const GA_ID = "G-VJBW01N7DM";

/**
 * Google Analytics, for whichever document renders it.
 *
 * The app has three: the merchant tree under [locale], the admin surface, and
 * the root 404 that catches anything matching neither. The tag used to live
 * inline in the first of them, so two thirds of the product were invisible.
 *
 * Consent Mode starts denied on every one of them, so nothing is stored until
 * the banner says otherwise. The merchant tree has that banner; the admin does
 * not, and it stays that way — measurement there is cookieless, which is what
 * an internal surface should be doing anyway.
 */
export default function Analytics() {
    return (
        <>
            <Script src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`} strategy="afterInteractive" />
            <Script id="ga-init" strategy="afterInteractive">
                {`
              window.dataLayer = window.dataLayer || [];
              function gtag(){dataLayer.push(arguments);}
              gtag('consent', 'default', {
                ad_storage: 'denied',
                ad_user_data: 'denied',
                ad_personalization: 'denied',
                analytics_storage: 'denied',
                wait_for_update: 500
              });
              gtag('js', new Date());
              gtag('config', '${GA_ID}');
            `}
            </Script>
        </>
    );
}
