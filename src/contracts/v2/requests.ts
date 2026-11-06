import { boolean, integer, nonEmptyString, object, optionalInstant, optionalString, string, WireError } from "./wire.ts";

export interface RequestsCapability { readonly enabled: boolean; readonly follow: boolean; readonly removeFailed: boolean }
export interface RequestState {
    readonly status?: string | undefined;
    readonly requestable: boolean; readonly following: boolean; readonly requestedByViewer: boolean;
    readonly id: string | undefined; readonly state: string | undefined; readonly reason: string | undefined;
}
export interface RequestTitle {
    readonly libraryContentId?: string | undefined;
    readonly year?: number | undefined; readonly runtime?: number | undefined; readonly voteAverage?: number | undefined;
    readonly contentRating?: string | undefined; readonly director?: string | undefined;
    readonly creators?: readonly string[] | undefined; readonly numberOfSeasons?: number | undefined;
    readonly genres?: readonly string[] | undefined; readonly recommendations?: readonly RequestTitle[] | undefined;
    readonly posterPath?: string | undefined; readonly backdropPath?: string | undefined;
    readonly mediaType: string; readonly tmdbId: number; readonly title: string;
    readonly overview: string | undefined; readonly availability: string; readonly request: RequestState;
}
export interface MediaRequest {
    readonly libraryContentId?: string | undefined;
    readonly year?: number | undefined;
    readonly createdAt?: number | undefined;
    readonly targets?: readonly { readonly quality: string | undefined; readonly status: string }[] | undefined;
    readonly posterPath?: string | undefined; readonly backdropPath?: string | undefined;
    readonly id: string; readonly mediaType: string; readonly tmdbId: number; readonly title: string;
    readonly state: string; readonly status: string; readonly outcome: string;
    readonly profileId: string | undefined; readonly overview: string | undefined;
}
export interface RequestPage { readonly results: readonly RequestTitle[]; readonly page: number; readonly totalPages: number; readonly nextPage: number }
export interface RequestSection extends RequestPage { readonly key: string; readonly title: string }
export interface MyRequests { readonly items: readonly MediaRequest[]; readonly cursor: string | undefined }
export interface RequestsHub { readonly sections: readonly RequestSection[]; readonly mine: MyRequests }

function optionalNumber(o: Record<string, unknown>, key: string): number | undefined {
    const value = o[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value)) throw new WireError(key, "a finite number");
    return value;
}

function array(value: unknown): unknown[] {
    if (!Array.isArray(value)) throw new WireError("requests", "an array");
    return value;
}
function optionalStrings(o: Record<string, unknown>, key: string): readonly string[] | undefined {
    return o[key] === undefined ? undefined : array(o[key]).map(value => {
        if (typeof value !== "string") throw new WireError(key, "strings");
        return value;
    });
}
/** Present boolean, or false when the server omits it. A non-boolean is a contract break. */
function optionalFlag(o: Record<string, unknown>, key: string): boolean {
    if (o[key] === undefined) return false;
    return boolean(o, key, "requests");
}
export function decodeRequestsCapability(value: unknown): RequestsCapability {
    const o = object(value, "requests.status");
    const enabled = boolean(o, "requests_enabled", "requests") && boolean(o, "allowed", "requests") && string(o, "state", "requests") === "available";
    // Apple RequestsFeatureStore: remove follows isAvailable, and an omitted flag is unsupported.
    return { enabled, follow: boolean(o, "follow_supported", "requests"), removeFailed: enabled && optionalFlag(o, "remove_failed_supported") };
}
export function decodeRequestState(value: unknown): RequestState {
    const o = object(value, "request");
    return { status: optionalString(o, "status", "requests"), requestable: boolean(o, "requestable", "requests"), following: boolean(o, "following", "requests"), requestedByViewer: boolean(o, "requested_by_viewer", "requests"), id: optionalString(o, "request_id", "requests"), state: optionalString(o, "state", "requests"), reason: optionalString(o, "reason", "requests") };
}
function identity(o: Record<string, unknown>): Pick<RequestTitle, "mediaType" | "tmdbId" | "title" | "overview" | "posterPath" | "backdropPath" | "libraryContentId"> {
    const tmdbId = integer(o, "tmdb_id", "requests");
    if (tmdbId < 1) throw new WireError("tmdb_id", "a positive integer");
    return { mediaType: string(o, "media_type", "requests"), tmdbId, title: nonEmptyString(o, "title", "requests"), overview: optionalString(o, "overview", "requests"), posterPath: optionalString(o, "poster_path", "requests"), backdropPath: optionalString(o, "backdrop_path", "requests"), libraryContentId: optionalString(o, "library_content_id", "requests") };
}
export function decodeRequestTitle(value: unknown): RequestTitle {
    const o = object(value, "request.title");
    return { ...identity(o), year: optionalNumber(o, "year"), runtime: optionalNumber(o, "runtime"), voteAverage: optionalNumber(o, "vote_average"), contentRating: optionalString(o, "content_rating", "requests"), director: optionalString(o, "director", "requests"), creators: optionalStrings(o, "creators"), numberOfSeasons: o.number_of_seasons === undefined ? undefined : integer(o, "number_of_seasons", "requests"), genres: optionalStrings(o, "genres"), recommendations: o.recommendations === undefined ? undefined : array(o.recommendations).map(decodeRequestTitle), availability: string(o, "availability", "requests"), request: decodeRequestState(o.request) };
}
export function decodeMediaRequest(value: unknown): MediaRequest {
    const o = object(value, "request");
    const targets = o.targets === undefined ? undefined : array(o.targets).map(value => {
        const target = object(value, "requests.targets");
        return { quality: optionalString(target, "quality", "requests.targets"), status: string(target, "status", "requests.targets") };
    });
    return { ...identity(o), year: optionalNumber(o, "year"), createdAt: optionalInstant(o, "created_at", "requests"), targets, id: nonEmptyString(o, "id", "requests"), state: string(o, "state", "requests"), status: string(o, "status", "requests"), outcome: string(o, "outcome", "requests"), profileId: optionalString(o, "requested_by_profile_id", "requests") };
}
export function decodeRequestPage(value: unknown): RequestPage {
    const o = object(value, "requests.page"), page = integer(o, "page", "requests"), totalPages = integer(o, "total_pages", "requests");
    const nextPage = o.next_page === undefined ? page + 1 : integer(o, "next_page", "requests");
    if (page < 1 || totalPages < 0 || nextPage <= page) throw new WireError("requests.page", "advancing pagination");
    return { results: array(o.results).map(decodeRequestTitle), page, totalPages, nextPage };
}
export function decodeRequestSection(value: unknown): RequestSection {
    const o = object(value, "requests.section");
    return { ...decodeRequestPage(value), key: nonEmptyString(o, "key", "requests"), title: string(o, "title", "requests") };
}
export function decodeDiscover(value: unknown): RequestSection[] {
    const o = object(value, "requests.discover");
    const items = array(o.items).map(decodeRequestSection);
    if (o.row_order === undefined) return items;
    return array(o.row_order).flatMap(value => {
        const row = object(value, "requests.row"), type = string(row, "type", "requests");
        if (!["tmdb_chart", "tmdb_discover", "tmdb_list", "mdblist"].includes(type)) return [];
        const section = items.find(item => item.key === string(row, "key", "requests"));
        return section === undefined ? [] : [section];
    });
}
export function decodeMyRequests(value: unknown): MyRequests {
    const o = object(value, "requests.mine"), page = o.page === undefined ? undefined : object(o.page, "page");
    const cursor = page !== undefined && boolean(page, "has_more", "requests") ? nonEmptyString(page, "next_cursor", "requests") : undefined;
    return { items: array(o.items).map(decodeMediaRequest), cursor };
}
