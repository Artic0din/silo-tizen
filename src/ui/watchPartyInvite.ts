// Apple's WatchPartyLobbyPolicy.inviteURL: the room's invite path, made into a link only for this server.

const SUFFIX = "/rooms/join";

/** The scheme, host, port and path of a server, or undefined for anything that is not a plain http(s) server address. */
function authority(value: string): string | undefined {
    let url: URL;
    try { url = new URL(value); } catch { return undefined; }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return undefined;
    const port = url.port === "" ? (url.protocol === "https:" ? "443" : "80") : url.port;
    return `${url.protocol}//${url.hostname}:${port}/${url.pathname.replace(/^\/+|\/+$/g, "")}`;
}

/**
 * The shareable web link for a room (`https://<server>/rooms/join?token=…`). A relative invite path is joined to
 * `serverUrl`; the link must carry exactly one non-empty token and name the same server, since its proof must
 * never go to a different one.
 */
export function inviteUrl(invitePath: string, serverUrl: string): string | undefined {
    let server: URL;
    try { server = new URL(serverUrl); } catch { return undefined; }
    let link: URL;
    try {
        const relative = !/^[a-z][a-z0-9+.-]*:/i.test(invitePath) && !invitePath.startsWith("//");
        if (relative) {
            const parsed = new URL(invitePath, "https://invite.invalid");
            if (parsed.pathname !== SUFFIX) return undefined;
            link = new URL(`${server.origin}${server.pathname.replace(/\/+$/, "")}${SUFFIX}${parsed.search}`);
        } else {
            link = new URL(invitePath);
        }
    } catch { return undefined; }
    if ((link.protocol !== "https:" && link.protocol !== "http:") || link.username !== "" || link.password !== "" || link.hash !== "" || !link.pathname.endsWith(SUFFIX)) return undefined;
    const tokens = link.searchParams.getAll("token");
    if (tokens.length !== 1 || tokens[0] === "") return undefined;
    const linked = authority(`${link.origin}${link.pathname.slice(0, -SUFFIX.length)}`);
    const own = authority(serverUrl);
    return linked !== undefined && linked === own ? link.href : undefined;
}
