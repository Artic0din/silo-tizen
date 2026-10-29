// Validates the server address a person types and derives the /api/v2 root from it.
// A reverse-proxy path prefix (https://example.test/silo) is kept, as the native
// Apple and Android clients keep it.

export interface ServerBase {
    /** scheme://host[:port], serialized like the server's `request_origin`. */
    readonly origin: string;
    /** origin plus any path prefix, no trailing slash. Identifies the server locally. */
    readonly baseUrl: string;
    /** baseUrl + "/api/v2". */
    readonly apiRoot: string;
}

export type ServerUrlProblem =
    | "empty"
    | "invalid"
    /** Only HTTPS carries account tokens; the platform's normal TLS validation applies. */
    | "not_https"
    | "has_credentials"
    | "has_query_or_fragment"
    /** The address already names an API path; enter the server address instead. */
    | "has_api_path";

export type ServerUrlResult =
    | { readonly ok: true; readonly base: ServerBase }
    | { readonly ok: false; readonly problem: ServerUrlProblem };

const API_PATH = /\/api(\/v\d+)?$/i;

export function parseServerUrl(input: string): ServerUrlResult {
    const trimmed = input.trim();
    if (trimmed === "") {
        return { ok: false, problem: "empty" };
    }
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    let url: URL;
    try {
        url = new URL(withScheme);
    } catch {
        return { ok: false, problem: "invalid" };
    }
    if (url.protocol !== "https:") {
        return { ok: false, problem: "not_https" };
    }
    if (url.hostname === "") {
        return { ok: false, problem: "invalid" };
    }
    if (url.username !== "" || url.password !== "") {
        return { ok: false, problem: "has_credentials" };
    }
    if (url.search !== "" || url.hash !== "" || withScheme.indexOf("?") !== -1 || withScheme.indexOf("#") !== -1) {
        return { ok: false, problem: "has_query_or_fragment" };
    }
    const prefix = url.pathname.replace(/\/+$/, "");
    if (API_PATH.test(prefix)) {
        return { ok: false, problem: "has_api_path" };
    }
    const baseUrl = url.origin + prefix;
    return { ok: true, base: { origin: url.origin, baseUrl, apiRoot: `${baseUrl}/api/v2` } };
}
