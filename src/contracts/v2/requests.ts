// Requests operations at silo-server cc8514943289045e7b9f7ac8d36d4968bfe93926 (openapi.json and fixtures/).
// Only consumed members are decoded; open response sets (state, status, phase) stay strings.
import { boolean, instant, integer, nonEmptyString, object, optionalString, string, WireError } from "./wire.ts";

export type RequestMediaType = "movie" | "series";
export type RequestFeatureState = "available" | "disabled" | "not_configured" | "unsupported" | "unknown";
export type BrandKind = "genres" | "networks" | "studios";

export interface RequestStatus {
    readonly revision: string;
    readonly state: RequestFeatureState;
    readonly allowed: boolean;
    readonly requestsEnabled: boolean;
    readonly followSupported: boolean;
    readonly discoverRowsSupported: boolean;
}
export interface RequestDownload { readonly phase: string; readonly percent: number | undefined }
export interface RequestMediaState {
    readonly requestable: boolean;
    readonly following: boolean;
    readonly requestedByViewer: boolean;
    readonly reason: string | undefined;
    readonly requestId: string | undefined;
    readonly state: string | undefined;
    readonly status: string | undefined;
    readonly download: RequestDownload | undefined;
}
export interface RequestMedia {
    readonly mediaType: RequestMediaType | "unknown";
    readonly tmdbId: number;
    readonly title: string;
    readonly year: number | undefined;
    readonly overview: string | undefined;
    readonly posterPath: string | undefined;
    readonly backdropPath: string | undefined;
    readonly availability: string;
    readonly libraryContentId: string | undefined;
    readonly request: RequestMediaState;
}
export interface RequestMediaPage {
    readonly page: number;
    readonly totalPages: number;
    /** Set when filling the page read past `page + 1`; may point past `totalPages`. */
    readonly nextPage: number | undefined;
    readonly results: readonly RequestMedia[];
}
export interface DiscoverRow extends RequestMediaPage { readonly key: string; readonly title: string }
export interface DiscoverRowRef { readonly key: string; readonly type: string; readonly title: string }
export interface DiscoverSections { readonly rowOrder: readonly DiscoverRowRef[]; readonly items: readonly DiscoverRow[] }
export interface DiscoverBrand { readonly slug: string; readonly displayName: string; readonly seriesSupported: boolean | undefined }
export interface RequestSeason { readonly seasonNumber: number; readonly episodeCount: number; readonly availability: string; readonly requested: boolean }
export interface RequestMediaDetail extends RequestMedia {
    readonly tvdbId: number | undefined;
    readonly genres: readonly string[];
    readonly runtime: number | undefined;
    readonly tagline: string | undefined;
    readonly contentRating: string | undefined;
    readonly seasons: readonly RequestSeason[];
}
export interface MediaRequest {
    readonly id: string;
    readonly mediaType: RequestMediaType | "unknown";
    readonly tmdbId: number;
    readonly title: string;
    readonly year: number | undefined;
    readonly posterPath: string | undefined;
    readonly status: string;
    readonly outcome: string;
    readonly state: string;
    readonly createdAt: number;
    readonly download: RequestDownload | undefined;
}
export interface MediaRequestPage { readonly items: readonly MediaRequest[]; readonly nextCursor: string | undefined }

const STATES: readonly RequestFeatureState[] = ["available", "disabled", "not_configured", "unsupported"];

function array(value: unknown, path: string): unknown[] {
    if (!Array.isArray(value)) throw new WireError(path, "an array");
    return value;
}
type Obj = ReturnType<typeof object>;
function optionalInteger(obj: Obj, key: string, path: string, minimum: number): number | undefined {
    if (obj[key] === undefined) return undefined;
    const value = integer(obj, key, path);
    if (value < minimum) throw new WireError(`${path}.${key}`, `an integer of at least ${minimum}`);
    return value;
}
function minimumInteger(obj: Obj, key: string, path: string, minimum: number): number {
    const value = integer(obj, key, path);
    if (value < minimum) throw new WireError(`${path}.${key}`, `an integer of at least ${minimum}`);
    return value;
}
function mediaType(obj: Obj, path: string): RequestMediaType | "unknown" {
    const value = string(obj, "media_type", path);
    return value === "movie" || value === "series" ? value : "unknown";
}

export function decodeRequestStatus(value: unknown): RequestStatus {
    const path = "request_status", obj = object(value, path);
    const state = string(obj, "state", path);
    return {
        revision: string(obj, "revision", path),
        state: STATES.find(known => known === state) ?? "unknown",
        allowed: boolean(obj, "allowed", path),
        requestsEnabled: boolean(obj, "requests_enabled", path),
        followSupported: boolean(obj, "follow_supported", path),
        discoverRowsSupported: boolean(obj, "discover_rows_supported", path),
    };
}
/** The Requests root exists only while the server offers it to this profile. */
export function requestsAvailable(status: RequestStatus): boolean {
    return status.state === "available" && status.allowed && status.requestsEnabled;
}

function download(value: unknown, path: string): RequestDownload | undefined {
    if (value === undefined) return undefined;
    const obj = object(value, path);
    const percent = optionalInteger(obj, "percent", path, 0);
    if (percent !== undefined && percent > 100) throw new WireError(`${path}.percent`, "a percentage");
    minimumInteger(obj, "downloads", path, 0);
    instant(obj, "updated_at", path);
    return { phase: string(obj, "phase", path), percent };
}
export function decodeRequestMediaState(value: unknown, path = "request"): RequestMediaState {
    const obj = object(value, path);
    return {
        requestable: boolean(obj, "requestable", path), following: boolean(obj, "following", path),
        requestedByViewer: boolean(obj, "requested_by_viewer", path), reason: optionalString(obj, "reason", path),
        requestId: optionalString(obj, "request_id", path), state: optionalString(obj, "state", path),
        status: optionalString(obj, "status", path), download: download(obj.download, `${path}.download`),
    };
}
function media(obj: Obj, path: string): RequestMedia {
    boolean(obj, "in_watchlist", path);
    return {
        mediaType: mediaType(obj, path), tmdbId: minimumInteger(obj, "tmdb_id", path, 1), title: string(obj, "title", path),
        year: optionalInteger(obj, "year", path, 0), overview: optionalString(obj, "overview", path),
        posterPath: optionalString(obj, "poster_path", path), backdropPath: optionalString(obj, "backdrop_path", path),
        availability: string(obj, "availability", path), libraryContentId: optionalString(obj, "library_content_id", path),
        request: decodeRequestMediaState(obj.request, `${path}.request`),
    };
}
function page(obj: Obj, path: string): RequestMediaPage {
    return {
        page: minimumInteger(obj, "page", path, 1), totalPages: minimumInteger(obj, "total_pages", path, 0),
        nextPage: optionalInteger(obj, "next_page", path, 1),
        results: array(obj.results, `${path}.results`).map((item, i) => media(object(item, `${path}.results[${i}]`), `${path}.results[${i}]`)),
    };
}
/** searchRequestMedia, browseDiscover{Genre,Network,Studio}, and getDiscoverSection/getDiscoverRow. */
export function decodeRequestMediaPage(value: unknown): RequestMediaPage {
    return page(object(value, "request_media_page"), "request_media_page");
}
function row(value: unknown, path: string): DiscoverRow {
    const obj = object(value, path);
    integer(obj, "total_results", path);
    return { ...page(obj, path), key: nonEmptyString(obj, "key", path), title: string(obj, "title", path) };
}
export function decodeDiscoverRow(value: unknown): DiscoverRow {
    return row(value, "discover_section");
}
export function decodeDiscoverSections(value: unknown): DiscoverSections {
    const path = "discover", obj = object(value, path);
    return {
        rowOrder: array(obj.row_order, `${path}.row_order`).map((value, i) => {
            const item = object(value, `${path}.row_order[${i}]`), at = `${path}.row_order[${i}]`;
            return { key: nonEmptyString(item, "key", at), type: string(item, "type", at), title: string(item, "title", at) };
        }),
        items: array(obj.items, `${path}.items`).map((item, i) => row(item, `${path}.items[${i}]`)),
    };
}
export function decodeDiscoverBrands(value: unknown): DiscoverBrand[] {
    const path = "discover_brands", obj = object(value, path);
    return array(obj.items, `${path}.items`).map((value, i) => {
        const at = `${path}.items[${i}]`, item = object(value, at);
        return { slug: nonEmptyString(item, "slug", at), displayName: string(item, "display_name", at), seriesSupported: item.series_supported === undefined ? undefined : boolean(item, "series_supported", at) };
    });
}
export function decodeRequestMediaDetail(value: unknown): RequestMediaDetail {
    const path = "request_detail", obj = object(value, path);
    const strings = (key: string): string[] => array(obj[key], `${path}.${key}`).map((item, i) => {
        if (typeof item !== "string") throw new WireError(`${path}.${key}[${i}]`, "a string");
        return item;
    });
    for (const key of ["cast", "creators", "production_companies", "networks", "recommendations"]) array(obj[key], `${path}.${key}`);
    return {
        ...media(obj, path), tvdbId: optionalInteger(obj, "tvdb_id", path, 1), genres: strings("genres"),
        runtime: optionalInteger(obj, "runtime", path, 0), tagline: optionalString(obj, "tagline", path),
        contentRating: optionalString(obj, "content_rating", path),
        seasons: array(obj.seasons, `${path}.seasons`).map((value, i) => {
            const at = `${path}.seasons[${i}]`, season = object(value, at);
            return {
                seasonNumber: minimumInteger(season, "season_number", at, 0), episodeCount: minimumInteger(season, "episode_count", at, 0),
                availability: string(season, "availability", at), requested: boolean(season, "requested", at),
            };
        }),
    };
}
export function decodeMediaRequest(value: unknown, path = "media_request"): MediaRequest {
    const obj = object(value, path);
    array(obj.targets, `${path}.targets`);
    array(obj.seasons, `${path}.seasons`);
    return {
        id: nonEmptyString(obj, "id", path), mediaType: mediaType(obj, path), tmdbId: minimumInteger(obj, "tmdb_id", path, 1),
        title: string(obj, "title", path), year: optionalInteger(obj, "year", path, 0), posterPath: optionalString(obj, "poster_path", path),
        status: string(obj, "status", path), outcome: string(obj, "outcome", path), state: string(obj, "state", path),
        createdAt: instant(obj, "created_at", path), download: download(obj.download, `${path}.download`),
    };
}
export function decodeMediaRequestPage(value: unknown): MediaRequestPage {
    const path = "my_requests", obj = object(value, path);
    let nextCursor: string | undefined;
    if (obj.page !== undefined) {
        const info = object(obj.page, `${path}.page`);
        nextCursor = boolean(info, "has_more", `${path}.page`) ? string(info, "next_cursor", `${path}.page`) : undefined;
        if (nextCursor === "") throw new WireError(`${path}.page.next_cursor`, "a nonempty continuation");
    }
    return { items: array(obj.items, `${path}.items`).map((item, i) => decodeMediaRequest(item, `${path}.items[${i}]`)), nextCursor };
}
