// Validates the server address a person types and derives the /api/v2 root from it.
// A reverse-proxy path prefix (https://example.test/silo) is kept, as the native
// Apple and Android clients keep it. Like the Apple TV app, an address without a scheme
// means HTTPS, a typed http:// means plain HTTP, and plain HTTP is never a downgrade
// from an HTTPS server.

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
    /** Neither https:// nor http://. HTTPS keeps the platform's normal TLS validation. */
    | "unsupported_scheme"
    | "has_credentials"
    | "has_query_or_fragment"
    /** The address already names an API path; enter the server address instead. */
    | "has_api_path";

export type ServerUrlResult =
    | { readonly ok: true; readonly base: ServerBase }
    | { readonly ok: false; readonly problem: ServerUrlProblem };

const API_PATH = /\/api(\/v\d+)?$/i;
/** The stock compose file's native API port; the Apple TV app's last plain-HTTP guess. */
const NATIVE_SERVER_PORT = "8090";
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const HAS_PORT = /^(\[[^\]]*\]|[^/?#:[]*):\d+(?:[/?#]|$)/;
const ADDRESS_PORT = /^(\[[^\]]*\]|[^/?#:[]*):(\d+)(?:[/?#]|$)/;

export function parseServerUrl(input: string): ServerUrlResult {
    const trimmed = input.trim();
    if (trimmed === "") {
        return { ok: false, problem: "empty" };
    }
    const withScheme = HAS_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`;
    let url: URL;
    try {
        url = new URL(withScheme);
    } catch {
        return { ok: false, problem: "invalid" };
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        return { ok: false, problem: "unsupported_scheme" };
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

/**
 * The plain-HTTP addresses to offer, in order, once a scheme-less address failed over HTTPS:
 * the same host and port, then port 8090 when none was typed. Empty for a typed scheme.
 */
export function plainHttpFallbacks(input: string): string[] {
    const trimmed = input.trim();
    if (HAS_SCHEME.test(trimmed)) {
        return [];
    }
    const typed = parseServerUrl(`http://${trimmed}`);
    if (!typed.ok) {
        return [];
    }
    const candidates = [typed.base.baseUrl];
    if (!HAS_PORT.test(trimmed)) {
        const url = new URL(typed.base.baseUrl);
        url.port = NATIVE_SERVER_PORT;
        candidates.push(url.href.replace(/\/$/, ""));
    }
    return candidates;
}

/** HTTPS anywhere; plain HTTP only when the server itself is plain HTTP. */
export function isPermittedUrl(url: URL, serverBaseUrl: string): boolean {
    return url.protocol === "https:" || (url.protocol === "http:" && serverBaseUrl.startsWith("http:"));
}

/** The Apple TV app's Advanced options: Auto keeps the typed scheme (or HTTPS, then the plain-HTTP question). */
export type AdvancedScheme = "auto" | "https" | "http";

export type AdvancedAddress = { readonly ok: true; readonly address: string } | { readonly ok: false; readonly problem: "invalid_port" };

/**
 * Which field a bad port belongs to. A port typed into the address (`host:70000`) is the
 * address's fault; only the Port field's own value outlines Port. A usable port is neither.
 */
export function portFieldFault(input: string, port: string): "address" | "port" | undefined {
    const scheme = HAS_SCHEME.exec(input.trim())?.[0] ?? "";
    const typed = ADDRESS_PORT.exec(input.trim().slice(scheme.length))?.[2];
    if (typed !== undefined) {
        return validPort(typed) ? undefined : "address";
    }
    const wanted = port.trim();
    if (wanted === "") {
        return undefined;
    }
    return validPort(wanted) ? undefined : "port";
}

function validPort(value: string): boolean {
    if (!/^\d+$/.test(value)) {
        return false;
    }
    const number = Number(value);
    return number >= 1 && number <= 65535;
}

/** Applies a chosen protocol (replacing a typed one) and a port (unless one was typed) to the address. */
export function advancedAddress(input: string, scheme: AdvancedScheme, port: string): AdvancedAddress {
    const typed = input.trim();
    if (typed === "") {
        return { ok: true, address: typed };
    }
    const typedScheme = HAS_SCHEME.exec(typed)?.[0] ?? "";
    const rest = typed.slice(typedScheme.length);
    let hostAndPath = rest;
    const wanted = port.trim();
    if (wanted !== "" && !HAS_PORT.test(rest)) {
        const value = /^\d+$/.test(wanted) ? Number(wanted) : 0;
        if (value < 1 || value > 65535) {
            return { ok: false, problem: "invalid_port" };
        }
        const end = rest.search(/[/?#]/);
        const at = end === -1 ? rest.length : end;
        hostAndPath = `${rest.slice(0, at)}:${value}${rest.slice(at)}`;
    }
    const prefix = scheme === "auto" ? typedScheme : `${scheme}://`;
    return { ok: true, address: prefix + hostAndPath };
}
