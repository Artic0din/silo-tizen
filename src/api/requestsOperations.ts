// Requests operations. Every factory must be passed to `session.call({ ...spec, profileScoped: true })`.
// Writes declare retry "never" and must also pass `replayAfterRefresh: false`: create and cancel are
// non_retryable, and follow/unfollow are only ever sent by an explicit press.
import {
    type BrandKind,
    decodeDiscoverBrands,
    decodeDiscoverRow,
    decodeDiscoverSections,
    decodeMediaRequest,
    decodeMediaRequestPage,
    decodeRequestMediaDetail,
    decodeRequestMediaPage,
    decodeRequestMediaState,
    decodeRequestStatus,
    type DiscoverBrand,
    type DiscoverRow,
    type DiscoverSections,
    type MediaRequest,
    type MediaRequestPage,
    type RequestMediaDetail,
    type RequestMediaPage,
    type RequestMediaState,
    type RequestMediaType,
    type RequestStatus,
} from "../contracts/v2/requests.ts";
import type { RequestSpec } from "./http.ts";

/** getDiscoverSection's closed key set; other title rows page through getDiscoverRow. */
export const BUILT_IN_ROWS = ["trending_movies", "trending_series", "popular_movies", "popular_series", "upcoming_movies", "on_air_series"];
/** TMDB serves at most 500 pages of any list, whatever total it reports. */
export const MAX_PROVIDER_PAGE = 500;
export const MY_REQUESTS_LIMIT = 24;

export type BrandBrowse = { readonly kind: "genres"; readonly slug: string; readonly mediaType: RequestMediaType } | { readonly kind: "networks" | "studios"; readonly slug: string };
export interface RequestCreate {
    readonly media_type: RequestMediaType;
    readonly tmdb_id: number;
    readonly title: string;
    readonly year?: number;
    readonly overview?: string;
    readonly poster_path?: string;
    readonly backdrop_path?: string;
    readonly tvdb_id?: number;
}

function pageNumber(page: number): number {
    if (!Number.isInteger(page) || page < 1 || page > MAX_PROVIDER_PAGE) throw new RangeError("Invalid provider page");
    return page;
}
function media(mediaType: RequestMediaType, tmdbId: number): string {
    if (mediaType !== "movie" && mediaType !== "series" || !Number.isInteger(tmdbId) || tmdbId < 1) throw new RangeError("Invalid request media");
    return `${mediaType}/${tmdbId}`;
}
const BRAND_PATHS: Readonly<Record<BrandKind, string>> = { genres: "genre", networks: "network", studios: "studio" };

export const requestsOperations = {
    requestStatus: (): RequestSpec<RequestStatus> => ({ method: "GET", path: "/requests/status", retry: "safe", decode: decodeRequestStatus }),
    discover: (): RequestSpec<DiscoverSections> => ({ method: "GET", path: "/requests/discover", retry: "safe", decode: decodeDiscoverSections }),
    /** Built-in keys use getDiscoverSection; an admin's rows need discover_rows_supported. */
    discoverRow: (key: string, page: number): RequestSpec<DiscoverRow> => {
        const builtIn = BUILT_IN_ROWS.includes(key);
        if (!builtIn && !/^[a-z0-9_]{1,40}$/.test(key)) throw new RangeError("Invalid Discover row");
        return { method: "GET", path: `/requests/discover/${builtIn ? "" : "rows/"}${key}?page=${pageNumber(page)}`, retry: "safe", decode: decodeDiscoverRow };
    },
    brands: (kind: BrandKind): RequestSpec<DiscoverBrand[]> => ({ method: "GET", path: `/requests/discover/${kind}`, retry: "safe", decode: decodeDiscoverBrands }),
    browseBrand: (brand: BrandBrowse, page: number): RequestSpec<RequestMediaPage> => {
        if (brand.slug === "") throw new RangeError("Invalid brand");
        const type = brand.kind === "genres" ? `media_type=${brand.mediaType === "series" ? "series" : "movie"}&` : "";
        return { method: "GET", path: `/requests/discover/browse/${BRAND_PATHS[brand.kind]}/${encodeURIComponent(brand.slug)}?${type}page=${pageNumber(page)}`, retry: "safe", decode: decodeRequestMediaPage };
    },
    search: (query: string, page: number): RequestSpec<RequestMediaPage> => {
        if (query.trim() === "") throw new RangeError("Empty request search");
        return { method: "GET", path: `/requests/search?q=${encodeURIComponent(query.trim())}&page=${pageNumber(page)}`, retry: "safe", decode: decodeRequestMediaPage };
    },
    detail: (mediaType: RequestMediaType, tmdbId: number): RequestSpec<RequestMediaDetail> => ({ method: "GET", path: `/requests/detail/${media(mediaType, tmdbId)}`, retry: "safe", decode: decodeRequestMediaDetail }),
    mine: (cursor: string | undefined): RequestSpec<MediaRequestPage> => ({
        method: "GET", path: `/requests/mine?limit=${MY_REQUESTS_LIMIT}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`, retry: "safe", decode: decodeMediaRequestPage,
    }),
    /** createRequest: non_retryable; omitted `seasons` asks for every aired season of a series. */
    create: (body: RequestCreate): RequestSpec<MediaRequest> => {
        media(body.media_type, body.tmdb_id);
        return { method: "POST", path: "/requests", retry: "never", body: { ...body }, decode: value => decodeMediaRequest(value) };
    },
    /** cancelRequest: non_retryable. */
    cancel: (id: string): RequestSpec<MediaRequest> => {
        if (id === "") throw new RangeError("Invalid request id");
        return { method: "POST", path: `/requests/${encodeURIComponent(id)}/cancel`, retry: "never", body: {}, decode: value => decodeMediaRequest(value) };
    },
    follow: (mediaType: RequestMediaType, tmdbId: number): RequestSpec<RequestMediaState> => ({ method: "PUT", path: `/requests/follows/${media(mediaType, tmdbId)}`, retry: "never", decode: value => decodeRequestMediaState(value) }),
    unfollow: (mediaType: RequestMediaType, tmdbId: number): RequestSpec<undefined> => ({ method: "DELETE", path: `/requests/follows/${media(mediaType, tmdbId)}`, retry: "never", decode: () => undefined }),
};
