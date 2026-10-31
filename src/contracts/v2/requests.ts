import { boolean, integer, nonEmptyString, object, optionalString, string, WireError } from "./wire.ts";

export interface RequestsCapability { readonly enabled: boolean; readonly follow: boolean }
export interface RequestState {
    readonly requestable: boolean; readonly following: boolean; readonly requestedByViewer: boolean;
    readonly id: string | undefined; readonly state: string | undefined; readonly reason: string | undefined;
}
export interface RequestTitle {
    readonly mediaType: string; readonly tmdbId: number; readonly title: string;
    readonly overview: string | undefined; readonly availability: string; readonly request: RequestState;
}
export interface MediaRequest {
    readonly id: string; readonly mediaType: string; readonly tmdbId: number; readonly title: string;
    readonly state: string; readonly status: string; readonly outcome: string;
    readonly profileId: string | undefined; readonly overview: string | undefined;
}
export interface RequestPage { readonly results: readonly RequestTitle[]; readonly page: number; readonly totalPages: number; readonly nextPage: number }
export interface RequestSection extends RequestPage { readonly key: string; readonly title: string }
export interface MyRequests { readonly items: readonly MediaRequest[]; readonly cursor: string | undefined }

function array(value: unknown): unknown[] {
    if (!Array.isArray(value)) throw new WireError("requests", "an array");
    return value;
}
export function decodeRequestsCapability(value: unknown): RequestsCapability {
    const o = object(value, "requests.status");
    return { enabled: boolean(o, "requests_enabled", "requests") && boolean(o, "allowed", "requests") && string(o, "state", "requests") === "available", follow: boolean(o, "follow_supported", "requests") };
}
export function decodeRequestState(value: unknown): RequestState {
    const o = object(value, "request");
    return { requestable: boolean(o, "requestable", "requests"), following: boolean(o, "following", "requests"), requestedByViewer: boolean(o, "requested_by_viewer", "requests"), id: optionalString(o, "request_id", "requests"), state: optionalString(o, "state", "requests"), reason: optionalString(o, "reason", "requests") };
}
function identity(o: Record<string, unknown>): { mediaType: string; tmdbId: number; title: string; overview: string | undefined } {
    const tmdbId = integer(o, "tmdb_id", "requests");
    if (tmdbId < 1) throw new WireError("tmdb_id", "a positive integer");
    return { mediaType: string(o, "media_type", "requests"), tmdbId, title: nonEmptyString(o, "title", "requests"), overview: optionalString(o, "overview", "requests") };
}
export function decodeRequestTitle(value: unknown): RequestTitle {
    const o = object(value, "request.title");
    return { ...identity(o), availability: string(o, "availability", "requests"), request: decodeRequestState(o.request) };
}
export function decodeMediaRequest(value: unknown): MediaRequest {
    const o = object(value, "request");
    return { ...identity(o), id: nonEmptyString(o, "id", "requests"), state: string(o, "state", "requests"), status: string(o, "status", "requests"), outcome: string(o, "outcome", "requests"), profileId: optionalString(o, "requested_by_profile_id", "requests") };
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
