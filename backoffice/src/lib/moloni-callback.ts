import { RIOKO_CONFIG } from "./config";

/**
 * The one URL a merchant registers in their Moloni developer app.
 *
 * Its own module because the wizard step is a browser component and the rest of
 * `moloni-oauth` is not: importing the callback URL from there pulled the token
 * exchange, and `moloni-token` behind it, into the client bundle for the sake of
 * one constant.
 *
 * The same URL for everybody, and it never changes — a Moloni developer app
 * holds exactly one, so a URL that varied per connection was "o redirect_uri não
 * coincide" the second time anyone used it.
 */
export const MOLONI_CALLBACK_PATH = "/api/integrations/moloni-oauth/callback";

export function moloniCallbackUri(): string {
    return `${RIOKO_CONFIG.appUrl}${MOLONI_CALLBACK_PATH}`;
}
