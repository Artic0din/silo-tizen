import { object, string } from "./wire.ts";

/** `GET /theme/branding`, read before sign-in; each text is trimmed and blank reads as absent. */
export interface ServerBranding {
    readonly serverName: string | undefined;
    /** Site-relative as the server sends it; see `resolveBrandingAsset`. */
    readonly markUrl: string | undefined;
    readonly accentColor: string | undefined;
}

/** Apple's optional branding document falls back as a whole if a text field is malformed. */
export function decodeServerBranding(value: unknown): ServerBranding {
    const row = object(value, "branding");
    for (const key of ["server_name", "login_subtitle", "accent_color", "wordmark_url", "mark_url"]) {
        if (row[key] !== undefined && row[key] !== null) string(row, key, "branding");
    }
    return { serverName: usable(row.server_name), markUrl: usable(row.mark_url), accentColor: usable(row.accent_color) };
}

function usable(value: unknown): string | undefined {
    return typeof value === "string" ? value.trim() || undefined : undefined;
}

/**
 * ServerBranding.resolve: a branding asset path under the server's base address, same origin only,
 * so branding can't point the app somewhere else. Stricter than Foundation where the browser's URL
 * parser is looser: backslashes, whitespace, control characters and credentials are refused.
 */
export function resolveBrandingAsset(value: string | undefined, baseUrl: string): string | undefined {
    if (value === undefined || value.trim() === "" || /[\\\s\u0000-\u001f\u007f]/.test(value)) {
        return undefined;
    }
    let base: URL;
    let url: URL;
    try {
        base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
        url = new URL(value.startsWith("/") ? value.slice(1) : value, base);
    } catch {
        return undefined;
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== base.origin || url.username !== "" || url.password !== "") {
        return undefined;
    }
    return url.href;
}
