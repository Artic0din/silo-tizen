import type { RequestSpec } from "./http.ts";
import { decodeThemeCapability, decodeThemePlayback, type ThemeAudioFormat, type ThemePlayback } from "../contracts/v2/themeMusic.ts";

export const themeMusicOperations = {
    themeCapability: (): RequestSpec<boolean> => ({ method: "GET", path: "/catalog/themes/capabilities", retry: "safe", decode: decodeThemeCapability }),
    /** natural_idempotent: a replay only issues another short-lived URL. An empty format list sends no body, which asks for the original. */
    themePlayback: (ownerId: string, themeId: string, formats: readonly ThemeAudioFormat[]): RequestSpec<ThemePlayback> => ({
        method: "POST", path: `/catalog/items/${encodeURIComponent(ownerId)}/themes/${encodeURIComponent(themeId)}/playback`, retry: "safe",
        ...(formats.length === 0 ? {} : { body: { accepted_formats: formats.map(format => ({ ...format })) } }), decode: decodeThemePlayback,
    }),
};
