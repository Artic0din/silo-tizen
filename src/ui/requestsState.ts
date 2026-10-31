// What each Requests screen holds and how it reads, kept free of the DOM so Node can test it.
// browse.ts owns loading, fencing and the router; requestsView.ts draws these states.
import { ApiError } from "../api/errors.ts";
import type { RequestSpec } from "../api/http.ts";
import { type BrandBrowse, MAX_PROVIDER_PAGE, requestsOperations } from "../api/requestsOperations.ts";
import {
    type BrandKind,
    type DiscoverBrand,
    type DiscoverSections,
    type MediaRequest,
    type MediaRequestPage,
    type RequestMediaDetail,
    type RequestMediaPage,
    type RequestMediaState,
    type RequestMediaType,
    requestsAvailable,
    type RequestStatus,
} from "../contracts/v2/requests.ts";

export type ResultsSource =
    | { readonly kind: "row"; readonly key: string }
    | { readonly kind: "brand"; readonly brand: BrandBrowse };
/** `want`: the page a read in flight will show, with the pages Previous then returns through. */
export interface ProviderPages { data: RequestMediaPage | undefined; previous: number[]; want: { page: number; previous: number[] } | undefined }
export type RequestAction = "create" | "cancel" | "follow" | "unfollow";
export type RequestsScreen =
    | { readonly screen: "hub"; data: DiscoverSections | undefined }
    | { readonly screen: "results"; readonly source: ResultsSource; readonly title: string; pages: ProviderPages }
    | { readonly screen: "search"; submitted: string | undefined; pages: ProviderPages }
    | { readonly screen: "brands"; readonly brand: BrandKind; readonly title: string; mediaType: RequestMediaType; data: DiscoverBrand[] | undefined }
    | { readonly screen: "detail"; readonly mediaType: RequestMediaType; readonly tmdbId: number; readonly title: string; data: RequestMediaDetail | undefined; pending: RequestAction | undefined; notice: { readonly text: string; readonly tone: "info" | "error" } | undefined }
    | { readonly screen: "mine"; cursors: (string | undefined)[]; index: number; pendingIndex: number | undefined; data: MediaRequestPage | undefined };

export type RequestsAnswer =
    | { readonly screen: "hub"; readonly data: DiscoverSections }
    | { readonly screen: "results" | "search"; readonly data: RequestMediaPage | undefined }
    | { readonly screen: "brands"; readonly data: DiscoverBrand[] }
    | { readonly screen: "detail"; readonly data: RequestMediaDetail }
    | { readonly screen: "mine"; readonly data: MediaRequestPage };

export function providerPages(): ProviderPages {
    return { data: undefined, previous: [], want: undefined };
}
export function requestsHub(): RequestsScreen {
    return { screen: "hub", data: undefined };
}
export function requestDetail(mediaType: RequestMediaType, tmdbId: number, title: string): RequestsScreen {
    return { screen: "detail", mediaType, tmdbId, title, data: undefined, pending: undefined, notice: undefined };
}

/** A page turn an abandoned read left unfinished, or a detail awaiting its post-write reread. */
export function requestsUnsettled(screen: RequestsScreen): boolean {
    return (screen.screen === "results" || screen.screen === "search") && screen.pages.want !== undefined
        || screen.screen === "mine" && screen.pendingIndex !== undefined || screen.screen === "detail" && screen.pending !== undefined;
}
export function requestsHasData(screen: RequestsScreen): boolean {
    switch (screen.screen) {
        case "search":
            return screen.submitted === undefined || screen.pages.data !== undefined;
        case "results":
            return screen.pages.data !== undefined;
        case "hub":
        case "brands":
        case "detail":
        case "mine":
            return screen.data !== undefined;
        default:
            return unreachable(screen);
    }
}

/** The feature is off for this profile: its routes close and the root hides. */
export class RequestsUnavailable extends Error {}
const UNAVAILABLE = ["capability_disabled", "capability_not_configured", "capability_unsupported"];
export function unavailableAnswer(error: unknown): boolean {
    return error instanceof RequestsUnavailable || error instanceof ApiError && (error.status === 501 || error.status === 409 && UNAVAILABLE.includes(error.problemId ?? ""));
}

/** One read for the screen; the hub reads status first and never lists a disabled feature. */
export async function readRequests(screen: RequestsScreen, read: <T>(spec: RequestSpec<T>) => Promise<T>, status: (value: RequestStatus) => void): Promise<RequestsAnswer> {
    try {
        switch (screen.screen) {
            case "hub": {
                const current = await read(requestsOperations.requestStatus());
                status(current);
                if (!requestsAvailable(current)) throw new RequestsUnavailable();
                return { screen: "hub", data: await read(requestsOperations.discover()) };
            }
            case "results": {
                const page = (screen.pages.want ?? { page: screen.pages.data?.page ?? 1 }).page;
                const source = screen.source;
                return { screen: "results", data: await read(source.kind === "row" ? requestsOperations.discoverRow(source.key, page) : requestsOperations.browseBrand(source.brand, page)) };
            }
            case "search": {
                const query = screen.submitted;
                const page = (screen.pages.want ?? { page: screen.pages.data?.page ?? 1 }).page;
                return { screen: "search", data: query === undefined ? undefined : await read(requestsOperations.search(query, page)) };
            }
            case "brands":
                return { screen: "brands", data: await read(requestsOperations.brands(screen.brand)) };
            case "detail":
                return { screen: "detail", data: await read(requestsOperations.detail(screen.mediaType, screen.tmdbId)) };
            case "mine":
                return { screen: "mine", data: await read(requestsOperations.mine(screen.cursors[screen.pendingIndex ?? screen.index])) };
            default:
                return unreachable(screen);
        }
    } catch (error) {
        if (unavailableAnswer(error)) throw new RequestsUnavailable();
        throw error;
    }
}

/** Publishes an answer; a different page always lands at the top of the grid. */
export function applyRequests(screen: RequestsScreen, answer: RequestsAnswer): void {
    switch (screen.screen) {
        case "results":
        case "search":
            if (answer.screen === "results" || answer.screen === "search") {
                const pages = screen.pages;
                if (pages.want !== undefined) pages.previous = pages.want.previous;
                pages.want = undefined;
                pages.data = answer.data;
            }
            return;
        case "mine":
            if (answer.screen === "mine") {
                const index = screen.pendingIndex ?? screen.index;
                screen.index = index;
                screen.pendingIndex = undefined;
                screen.cursors = [...screen.cursors.slice(0, index + 1), answer.data.nextCursor];
                screen.data = answer.data;
            }
            return;
        case "hub":
            if (answer.screen === "hub") screen.data = answer.data;
            return;
        case "brands":
            if (answer.screen === "brands") screen.data = answer.data;
            return;
        case "detail":
            // Writes stay blocked until the reread shows what the server holds.
            if (answer.screen === "detail") { screen.data = answer.data; screen.pending = undefined; }
            return;
        default:
            unreachable(screen);
    }
}

/** The next provider page, or undefined at the end (TMDB stops at page 500). */
export function nextProviderPage(page: RequestMediaPage): number | undefined {
    const next = page.nextPage ?? page.page + 1;
    return next > page.page && next <= Math.min(page.totalPages, MAX_PROVIDER_PAGE) ? next : undefined;
}
/** Plans a page turn; false when there is nothing that way. */
export function turnProviderPage(pages: ProviderPages, step: -1 | 1): boolean {
    const shown = pages.data;
    if (shown === undefined || pages.want !== undefined) return false;
    if (step === 1) {
        const next = nextProviderPage(shown);
        if (next === undefined) return false;
        pages.want = { page: next, previous: [...pages.previous, shown.page] };
        return true;
    }
    const back = pages.previous[pages.previous.length - 1];
    if (back === undefined) return false;
    pages.want = { page: back, previous: pages.previous.slice(0, -1) };
    return true;
}

export function requestCardKey(mediaType: string, tmdbId: number): string {
    return `${mediaType}:${tmdbId}`;
}

const STATE_LABELS: Readonly<Record<string, string>> = {
    pending: "Pending", approved: "Approved", processing: "Processing", partially_available: "Partially available",
    available: "Available", declined: "Declined", cancelled: "Cancelled", failed: "Failed",
};
const REASON_LABELS: Readonly<Record<string, string>> = {
    already_requested: "Already requested", already_available: "Available", requests_disabled: "Requests are off",
    blocked: "Requests are blocked for this account", quota_exceeded: "Request limit reached",
};
function own(record: Readonly<Record<string, string>>, key: string | undefined): string | undefined {
    return key !== undefined && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}
function progress(label: string, download: { readonly percent: number | undefined } | undefined): string {
    return download?.percent === undefined ? label : `${label} · ${download.percent}%`;
}
/** The one state a person sees for a title, its request or why it cannot be requested. */
export function mediaStateLabel(availability: string, request: RequestMediaState): string | undefined {
    if (availability === "available") return "Available";
    if (request.requestId !== undefined || request.state !== undefined) return progress(own(STATE_LABELS, request.state) ?? "Requested", request.download);
    if (!request.requestable) return own(REASON_LABELS, request.reason) ?? "Unavailable";
    return undefined;
}
export function requestStateLabel(request: MediaRequest): string {
    return progress(own(STATE_LABELS, request.state) ?? "Requested", request.download);
}

export interface RequestChoices {
    readonly request: boolean;
    readonly cancel: boolean;
    readonly follow: boolean;
    readonly unfollow: boolean;
}
/** Which writes the detail offers; the server repeats every check when one is sent. */
export function requestChoices(detail: RequestMediaDetail, status: RequestStatus | undefined): RequestChoices {
    const request = detail.request, active = request.requestId !== undefined;
    const follows = status?.followSupported === true && active && !request.requestedByViewer;
    return {
        request: request.requestable && detail.availability !== "available" && !active,
        cancel: active && request.requestedByViewer && (request.status === "pending" || request.status === "approved"),
        follow: follows && !request.following,
        unfollow: follows && request.following,
    };
}
export function createBody(detail: RequestMediaDetail): Parameters<typeof requestsOperations.create>[0] {
    if (detail.mediaType === "unknown") throw new RangeError("Unknown media type");
    return {
        media_type: detail.mediaType, tmdb_id: detail.tmdbId, title: detail.title,
        ...(detail.year === undefined || detail.year === 0 ? {} : { year: detail.year }),
        ...(detail.overview ? { overview: detail.overview } : {}),
        ...(detail.posterPath ? { poster_path: detail.posterPath } : {}),
        ...(detail.backdropPath ? { backdrop_path: detail.backdropPath } : {}),
        ...(detail.tvdbId === undefined ? {} : { tvdb_id: detail.tvdbId }),
    };
}
/** Sends one explicit write. The caller never resends it; a refreshed detail shows what happened. */
export function sendRequestAction(action: RequestAction, detail: RequestMediaDetail, call: <T>(spec: RequestSpec<T>) => Promise<T>): Promise<unknown> {
    if (detail.mediaType === "unknown") return Promise.reject(new RangeError("Unknown media type"));
    switch (action) {
        case "create":
            return call(requestsOperations.create(createBody(detail)));
        case "cancel":
            return call(requestsOperations.cancel(detail.request.requestId ?? ""));
        case "follow":
            return call(requestsOperations.follow(detail.mediaType, detail.tmdbId));
        case "unfollow":
            return call(requestsOperations.unfollow(detail.mediaType, detail.tmdbId));
        default:
            return unreachable(action);
    }
}
const DONE: Readonly<Record<RequestAction, string>> = { create: "Requested.", cancel: "Request cancelled.", follow: "Following. You will be told when it is available.", unfollow: "No longer following." };
export function actionDone(action: RequestAction): string {
    return DONE[action];
}
/** A refused or unconfirmed write is described, never resent. */
export function actionFailure(error: unknown): string {
    if (error instanceof ApiError) {
        const kind = error.failure.kind;
        if (kind === "network" || kind === "timeout" || kind === "invalid_response" || error.status !== undefined && error.status >= 500) {
            return "The server did not confirm the change. Check the title below before trying again.";
        }
        if (error.status === 403) return "This profile cannot make that change.";
        if (error.status === 404) return "This title or request is no longer available.";
        if (error.status === 409) return "The request changed on the server. The title below is up to date.";
        if (error.status === 429) return "Too many changes. Try again later.";
    }
    return "The change could not be made. Try again.";
}

function unreachable(value: never): never {
    throw new Error(`Unhandled Requests value ${String(value)}`);
}
