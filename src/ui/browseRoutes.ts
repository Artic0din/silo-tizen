// The places browse can show, what each holds, and which view each state shows: loading,
// failed, or its data (with a note when a refresh or page turn failed). Loading lives in browse.ts.

import { ApiError } from "../api/errors.ts";
import type { TextSearchScope } from "../api/operations.ts";
import type { CatalogPage, Episode, HomeSection, ItemDetail, Season, UserLibrary } from "../contracts/v2/catalog.ts";
import type { Person } from "../contracts/v2/details.ts";
import type { DetailsState } from "./detailsState.ts";
import { SessionError } from "../session/session.ts";
import type { FocusTarget, View } from "./browseFocus.ts";
import { itemView, personView, seasonView, type Synopsis } from "./browseDetails.ts";
import type { PlayRequest, SeriesContext } from "./browseModel.ts";
import type { CalendarState } from "./calendarState.ts";
import { calendarView, type CalendarHandlers } from "./calendarView.ts";
import { actionButton, homeView, lines, pagedGrid, type SearchResults, searchView, statusView, type ViewContext, zoneNode } from "./browseViews.ts";
import { el } from "./screen.ts";
import { discoveryState, type DiscoveryState, type LibraryMode, type LibrarySource } from "./libraryDiscovery.ts";
import { discoveryView, resultsView } from "./libraryDiscoveryViews.ts";
import { personalView, type PersonalFilter, type PersonalSource, type PersonalListCapability } from "./personalLists.ts";
import type { MediaScope } from "../contracts/v2/discovery.ts";
import { personFilmographyView } from "./personFilmography.ts";

/** Cards per catalog page: four grid rows. Only the shown page is kept. */
export const PAGE_SIZE = 24;

export interface Pages {
    page: CatalogPage | undefined;
    index: number;
    /** cursors[i] opens page i; page 0 has none. */
    cursors: (string | undefined)[];
}

export type RouteData =
    | { readonly kind: "personFilmography"; readonly id: string; readonly title: string; filter: MediaScope; pages: Pages; pendingIndex: number | undefined }
    | { readonly kind: "calendar"; readonly calendar: CalendarState }
    | { readonly kind: "personal"; readonly source: PersonalSource; filter: PersonalFilter; capability: PersonalListCapability | undefined; pages: Pages; pendingIndex: number | undefined }
    | { readonly kind: "home"; data: { libraries: UserLibrary[]; sections: HomeSection[] } | undefined }
    | { readonly kind: "homeSection"; readonly id: string; readonly title: string; readonly continuing: boolean; pages: Pages; pendingIndex: number | undefined }
    | { readonly kind: "resume"; readonly id: string; readonly title: string }
    | { readonly kind: "library"; readonly library: UserLibrary; pages: Pages; discovery?: DiscoveryState }
    | { readonly kind: "libraryResults"; readonly library: UserLibrary; readonly title: string; readonly source: LibrarySource; pages: Pages; descending: boolean }
    /** `resultsFor`: the query the shown page answers, which typing can move ahead of. */
    | { readonly kind: "search"; query: string; pages: Pages | undefined; resultsFor: string; searchType?: TextSearchScope }
    | { readonly kind: "item"; readonly id: string; readonly title: string; readonly seriesContext?: SeriesContext; data: { detail: ItemDetail; seasons: Season[]; details?: DetailsState } | undefined }
    | { readonly kind: "person"; readonly id: string; readonly title: string; data: { person: Person; titles: CatalogPage } | undefined }
    | { readonly kind: "season"; readonly seriesId: string; readonly seasonNumber: number; readonly title: string; readonly id?: string; readonly episodeId?: string; data: { episodes: Episode[]; detail: ItemDetail | undefined; details?: DetailsState } | undefined };

export type Route = RouteData & {
    /** Where focus was when another route covered this one. */
    focus: FocusTarget | undefined;
    failure: string | undefined;
    slow: boolean;
    /** Shown data may be out of date (after playback): refresh it in place when shown. */
    stale: boolean;
};

export function newRoute(data: RouteData): Route {
    return { ...data, focus: undefined, failure: undefined, slow: false, stale: false };
}

export function newPages(): Pages {
    return { page: undefined, index: 0, cursors: [undefined] };
}

export function hasData(current: Route): boolean {
    switch (current.kind) {
        case "calendar":
            return current.calendar.data !== undefined;
        case "resume":
            return false;
        case "personal":
            return current.pages.page !== undefined || current.capability !== undefined;
        case "library":
            return current.discovery?.data !== undefined && (!(current.discovery.mode === "A–Z" || current.discovery.mode === "Recently Added" || current.discovery.genre !== undefined) || current.pages.page !== undefined);
        case "libraryResults":
        case "personFilmography":
        case "homeSection":
            return current.pages.page !== undefined;
        case "search":
            return current.pages?.page !== undefined;
        default:
            return current.data !== undefined;
    }
}

export interface RouteHandlers {
    readonly personFilter: (route: Extract<Route, { kind: "personFilmography" }>, filter: MediaScope) => void;
    readonly calendar: (route: Extract<Route, { kind: "calendar" }>) => CalendarHandlers;
    readonly personalFilter: (route: Extract<Route, { kind: "personal" }>, filter: PersonalFilter) => void;
    readonly synopsis: Synopsis;
    readonly context: ViewContext;
    readonly focusDefault: () => void;
    /** A read is in flight. */
    readonly busy: boolean;
    /** The search heading, label and field, kept across renders. */
    readonly searchHead: readonly HTMLElement[];
    readonly input: HTMLInputElement;
    readonly push: (route: Route) => void;
    readonly pop: () => void;
    readonly play: (request: PlayRequest) => void;
    readonly chooseProfile: () => void;
    readonly retry: (route: Route) => void;
    readonly turn: (route: Route, pages: Pages, step: -1 | 1) => void;
    readonly mode: (route: Extract<Route, { kind: "library" }>, mode: LibraryMode) => void;
    readonly jump: (route: Extract<Route, { kind: "library" }>, letter: string, position: number) => void;
    readonly sort: (route: Extract<Route, { kind: "libraryResults" | "library" }>) => void;
    readonly genre: (route: Extract<Route, { kind: "library" }>, name: string | undefined) => void;
}

export function routeView(current: Route, handlers: RouteHandlers): View {
    const { context, pop } = handlers;
    if (current.kind === "calendar") return calendarView(current.calendar, handlers.calendar(current));
    const back = current.kind === "home" ? undefined : pop;
    const escape = back === undefined ? actionButton("profiles", "Profiles", handlers.chooseProfile) : actionButton("back", "Back", back);
    if (current.kind === "personal") return personalView(current, handlers);
    if (current.kind === "personFilmography") return personFilmographyView(current, handlers);
    if (current.kind === "library") {
        current.discovery ??= discoveryState();
        return discoveryView(current, current.discovery, handlers);
    }
    if (current.kind === "search") {
        return searchView(handlers.searchHead, handlers.input, searchResults(current, handlers), pop);
    }
    if (current.failure !== undefined && !hasData(current)) {
        return statusView(`${current.kind}:failed`, "Something went wrong", [current.failure], [actionButton("retry", "Try again", () => handlers.retry(current)), escape], back, "error");
    }
    switch (current.kind) {
        case "home":
            if (current.data !== undefined) {
                const view = homeView(current.data.libraries, current.data.sections, context, {
                    expand: section => handlers.push(newRoute({ kind: "homeSection", id: section.id, title: section.title, continuing: section.sectionType === "continue_watching", pages: newPages(), pendingIndex: undefined })),
                    search: () => handlers.push(newRoute({ kind: "search", query: "", pages: undefined, resultsFor: "" })),
                    library: (library) => handlers.push(newRoute({ kind: "library", library, pages: newPages() })),
                    chooseProfile: handlers.chooseProfile,
                });
                if (current.failure === undefined && !handlers.busy) return view;
                const retry = current.failure === undefined ? [] : [actionButton("retry", "Try again", () => handlers.retry(current))];
                return { ...view, content: [...view.content, ...lines([current.failure ?? "Refreshing titles."], current.failure === undefined ? "info" : "error"), zoneNode("browse-actions", retry)], zones: [...view.zones, { id: "status", layout: "row", items: retry }] };
            }
            break;
        case "homeSection":
            if (current.pages.page !== undefined) {
                const contents = grid(current, current.pages, current.pages.page, { ...handlers, context: { ...context, continueWatching: current.continuing } });
                const actions = [escape, ...(current.failure === undefined ? [] : [actionButton("retry", "Try again", () => handlers.retry(current))])];
                return {
                    name: `homeSection:${current.id}`,
                    content: [el("h1", "browse-title", current.title), ...contents.content,
                        ...lines(current.failure === undefined ? (current.pages.page.items.length === 0 ? ["No titles available."] : []) : [current.failure], current.failure === undefined ? "info" : "error"), zoneNode("browse-actions", actions)],
                    zones: [...contents.zones, { id: "actions", layout: "row", items: actions }],
                    focus: contents.zones[0]?.items[0] === undefined ? { zone: "actions", key: "back" } : { zone: "grid", key: contents.zones[0].items[0].key }, back: pop,
                };
            }
            break;
        case "resume":
            break;
        case "libraryResults":
            if (current.pages.page !== undefined) {
                return resultsView(current, grid(current, current.pages, current.pages.page, handlers), handlers);
            }
            break;
        case "item":
            if (current.data !== undefined) {
                const episodeId = current.seriesContext?.episodeId;
                const view = itemView(current.data.details?.detail ?? current.data.detail, current.data.seasons, {
                    ...context, open: destination => context.open(destination.kind === "season" && episodeId !== undefined ? { ...destination, episodeId } : destination),
                }, handlers.play, pop, handlers.synopsis, current.data.details);
                return withNote(view, current.failure);
            }
            break;
        case "person":
            if (current.data !== undefined) return personView(current.data.person, current.data.titles.items, context, pop, handlers.synopsis,
                () => handlers.push(newRoute({ kind: "personFilmography", id: current.id, title: current.data?.person.name ?? current.title, filter: "video", pages: newPages(), pendingIndex: undefined })));
            break;
        case "season":
            if (current.data !== undefined) {
                return withNote(seasonView(`season:${current.seriesId}:${current.seasonNumber}`, current.title, current.data.episodes, context, pop, handlers.play, handlers.synopsis, current.data.details?.detail ?? current.data.detail, current.data.details), current.failure);
            }
    }
    return statusView(`${current.kind}:loading`, "Loading", current.slow ? ["Still waiting for the server."] : [], [escape], back);
}

function grid(current: Route, pages: Pages, page: CatalogPage, handlers: RouteHandlers): ReturnType<typeof pagedGrid> {
    return pagedGrid(
        {
            page,
            index: pages.index,
            pageSize: PAGE_SIZE,
            loading: handlers.busy,
            previous: () => handlers.turn(current, pages, -1),
            next: () => handlers.turn(current, pages, 1),
        },
        handlers.context,
    );
}

function searchResults(current: Extract<Route, { kind: "search" }>, handlers: RouteHandlers): SearchResults {
    const pages = current.pages;
    if (current.failure !== undefined) {
        return { status: "failed", text: current.failure, retry: () => handlers.retry(current) };
    }
    if (pages === undefined) {
        return { status: "idle" };
    }
    if (pages.page === undefined) {
        return { status: "searching" };
    }
    return { status: "ready", query: current.resultsFor, grid: grid(current, pages, pages.page, handlers) };
}

/** A failed refresh or page turn keeps what is shown and says why above it. */
function withNote(view: View, failure: string | undefined): View {
    if (failure === undefined) {
        return view;
    }
    const note = el("p", "browse-text browse-error", failure);
    note.setAttribute("role", "alert");
    return { ...view, content: [note, ...view.content] };
}

/** What to tell the person; undefined for an error that is not a server or session answer (a defect). */
export function failureText(error: unknown, current: Route): string | undefined {
    if (error instanceof SessionError) {
        return error.reason === "unavailable" ? "The server had a problem. Try again in a moment." : "This TV is no longer signed in.";
    }
    if (!(error instanceof ApiError)) {
        return undefined;
    }
    const kind = error.failure.kind;
    if (kind === "network" || kind === "timeout") {
        return "Could not reach the server. Check the connection and try again.";
    }
    if (error.status === 404) {
        if (current.kind === "calendar") return "Could not load Calendar. Try again.";
        return current.kind === "library"
            ? "This library is no longer available."
            : current.kind === "season"
              ? "This season is no longer available."
              : current.kind === "person" ? "This person is no longer available." : "This title is no longer available.";
    }
    if (error.problemId === "invalid_cursor") {
        if (current.kind === "homeSection" || current.kind === "personFilmography") return "The list changed. Try again.";
        return "The list changed. Go back and open it again.";
    }
    if (kind === "invalid_response") {
        return "The server sent an answer this TV could not read.";
    }
    return error.transient ? "The server had a problem. Try again in a moment." : "Something went wrong. Try again.";
}
