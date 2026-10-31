import { decodeDiscover, decodeMediaRequest, decodeMyRequests, decodeRequestPage, decodeRequestSection, decodeRequestState, decodeRequestsCapability, decodeRequestTitle, type RequestTitle } from "../contracts/v2/requests.ts";
import type { RequestSpec } from "./http.ts";

function get<T>(path: string, decode: (value: unknown) => T): RequestSpec<T> { return { method: "GET", path: `/requests${path}`, retry: "safe", decode }; }
function media(title: Pick<RequestTitle, "mediaType" | "tmdbId">): string {
    if (!["movie", "series"].includes(title.mediaType) || !Number.isSafeInteger(title.tmdbId) || title.tmdbId < 1) throw new RangeError("Invalid request media identity");
    return `${title.mediaType}/${title.tmdbId}`;
}
export const requestOperations = {
    status: () => get("/status", decodeRequestsCapability),
    discover: () => get("/discover", decodeDiscover),
    row: (key: string, page: number) => get(`/discover/rows/${encodeURIComponent(key)}?page=${page}`, decodeRequestSection),
    search: (query: string, page: number) => get(`/search?q=${encodeURIComponent(query)}&media_type=all&page=${page}`, decodeRequestPage),
    detail: (title: Pick<RequestTitle, "mediaType" | "tmdbId">) => get(`/detail/${media(title)}`, decodeRequestTitle),
    mine: (cursor?: string) => get(`/mine?limit=24${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`, decodeMyRequests),
    request: (id: string) => get(`/${encodeURIComponent(id)}`, decodeMediaRequest),
    create: (title: RequestTitle): RequestSpec<unknown> => {
        media(title);
        return { method: "POST", path: "/requests", retry: "never", body: { media_type: title.mediaType, tmdb_id: title.tmdbId, title: title.title }, decode: decodeMediaRequest };
    },
    cancel: (id: string): RequestSpec<unknown> => ({ method: "POST", path: `/requests/${encodeURIComponent(id)}/cancel`, retry: "never", body: {}, decode: decodeMediaRequest }),
    follow: (title: RequestTitle, following: boolean): RequestSpec<unknown> => ({ method: following ? "PUT" : "DELETE", path: `/requests/follows/${media(title)}`, retry: "never", decode: following ? decodeRequestState : () => undefined }),
};
