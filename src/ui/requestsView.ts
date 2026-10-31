// DOM for the Requests screens. Nothing here fetches: presses call the handlers, and focus moves
// only through FocusHost. Cards and buttons keep stable keys so focus returns by zone and key.
import { BUILT_IN_ROWS } from "../api/requestsOperations.ts";
import type { BrandKind, MediaRequest, RequestMedia, RequestMediaPage, RequestMediaType, RequestStatus } from "../contracts/v2/requests.ts";
import type { FocusItem, View, Zone } from "./browseFocus.ts";
import { actionButton, artwork, GRID_COLUMNS, lines, zoneNode } from "./browseViews.ts";
import {
    mediaStateLabel,
    nextProviderPage,
    providerPages,
    requestCardKey,
    requestChoices,
    requestDetail,
    type RequestAction,
    type RequestsScreen,
    requestStateLabel,
    type ProviderPages,
} from "./requestsState.ts";
import { el } from "./screen.ts";

export interface RequestsHandlers {
    readonly status: RequestStatus | undefined;
    readonly busy: boolean;
    readonly slow: boolean;
    readonly failure: string | undefined;
    readonly baseUrl: string;
    /** The search field, kept across renders so the TV keyboard open on it is never detached. */
    readonly input: HTMLInputElement;
    readonly open: (screen: RequestsScreen) => void;
    readonly openItem: (id: string, title: string) => void;
    readonly retry: () => void;
    /** Undefined on the root, where Skyline owns Back. */
    readonly back: (() => void) | undefined;
    readonly turn: (step: -1 | 1) => void;
    readonly mediaType: (type: RequestMediaType) => void;
    readonly act: (action: RequestAction) => void;
}

const BRAND_TYPES: readonly BrandKind[] = ["studios", "networks", "genres"];
/** Row types listDiscoverSections documents as title rows; a client skips types it does not know. */
const TITLE_ROWS = ["tmdb_chart", "tmdb_discover", "tmdb_list", "mdblist"];
const PENDING: Readonly<Record<RequestAction, string>> = { create: "Requesting", cancel: "Cancelling", follow: "Following", unfollow: "Unfollowing" };
const TMDB_POSTER = "https://image.tmdb.org/t/p/w342";

export function requestsSearchInput(): HTMLInputElement {
    const input = el("input", "browse-input");
    input.id = "requests-search";
    input.type = "search";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("data-focus", "query");
    return input;
}
/** TMDB paths only; anything else shows the title placeholder. */
export function posterUrl(path: string | undefined): string | undefined {
    return path !== undefined && /^\/[A-Za-z0-9._-]+$/.test(path) ? TMDB_POSTER + path : undefined;
}

function card(key: string, title: string, subtitle: readonly (string | undefined)[], poster: string | undefined, baseUrl: string, press: () => void): FocusItem {
    const item = actionButton(key, "", press);
    item.element.className = "browse-card";
    item.element.append(artwork("browse-art", posterUrl(poster), baseUrl, title), el("span", "browse-card-title", title));
    const text = subtitle.filter(part => part !== undefined && part !== "").join(" · ");
    if (text !== "") item.element.appendChild(el("span", "browse-card-subtitle", text));
    return item;
}
function mediaCards(results: readonly RequestMedia[], handlers: RequestsHandlers): FocusItem[] {
    const cards: FocusItem[] = [];
    for (const media of results) {
        const type = media.mediaType;
        if (type === "unknown") continue;
        cards.push(card(requestCardKey(type, media.tmdbId), media.title, [media.year === undefined || media.year === 0 ? undefined : String(media.year), mediaStateLabel(media.availability, media.request)],
            media.posterPath, handlers.baseUrl, () => handlers.open(requestDetail(type, media.tmdbId, media.title))));
    }
    return cards;
}
function requestCard(request: MediaRequest, handlers: RequestsHandlers): FocusItem {
    const type = request.mediaType;
    const item = card(`request:${request.id}`, request.title, [request.year === undefined || request.year === 0 ? undefined : String(request.year), requestStateLabel(request)], request.posterPath, handlers.baseUrl,
        () => { if (type !== "unknown") handlers.open(requestDetail(type, request.tmdbId, request.title)); });
    if (type === "unknown") item.element.setAttribute("aria-disabled", "true");
    return item;
}

interface Body { readonly content: HTMLElement[]; readonly zones: Zone[] }
function frame(name: string, title: string, controls: FocusItem[], body: Body, handlers: RequestsHandlers, hasData: boolean, preferred?: string): View {
    if (handlers.failure !== undefined) controls.push(actionButton("retry", "Try again", handlers.retry));
    const content: HTMLElement[] = [el("h1", "browse-title", title), zoneNode("browse-actions", controls)];
    const zones: Zone[] = [{ id: "actions", layout: "row", items: controls }];
    if (handlers.failure !== undefined) content.push(...lines([handlers.failure], "error"));
    else if (!hasData || handlers.busy) {
        const status = el("p", "browse-text", hasData ? "Refreshing." : "Loading");
        status.setAttribute("role", "status");
        content.push(status, ...(handlers.slow ? lines(["Still waiting for the server."]) : []));
    }
    content.push(...body.content);
    zones.push(...body.zones);
    const first = zones.find(zone => zone.id === preferred && zone.items.length > 0) ?? body.zones.find(zone => zone.items.length > 0) ?? zones[0];
    const item = first?.items[0];
    return { name, content, zones, focus: item === undefined ? undefined : { zone: first?.id ?? "actions", key: item.key }, back: handlers.back };
}
function backButton(handlers: RequestsHandlers): FocusItem[] {
    return handlers.back === undefined ? [] : [actionButton("back", "Back", handlers.back)];
}
function pagedResults(pages: ProviderPages, empty: string, handlers: RequestsHandlers): Body {
    const page: RequestMediaPage | undefined = pages.data;
    if (page === undefined) return { content: [], zones: [] };
    const cards = mediaCards(page.results, handlers);
    const pager: FocusItem[] = [];
    if (pages.previous.length > 0) pager.push(actionButton("previous", "Previous page", () => handlers.turn(-1)));
    if (nextProviderPage(page) !== undefined) pager.push(actionButton("next", "Next page", () => handlers.turn(1)));
    const position = el("p", "browse-text browse-page-status", pages.want !== undefined ? "Loading the page." : `Page ${page.page} of ${Math.max(page.page, Math.min(page.totalPages, 500))}`);
    position.setAttribute("role", "status");
    return {
        content: [...(cards.length === 0 ? lines([empty]) : []), zoneNode("browse-grid", cards), ...(cards.length === 0 && pager.length === 0 ? [] : [position]), zoneNode("browse-actions", pager)],
        zones: [{ id: "grid", layout: "grid", columns: GRID_COLUMNS, items: cards }, { id: "pager", layout: "row", items: pager }],
    };
}

function hubView(screen: Extract<RequestsScreen, { screen: "hub" }>, handlers: RequestsHandlers): View {
    const controls = [
        actionButton("find", "Search", () => handlers.open({ screen: "search", submitted: undefined, pages: providerPages() })),
        actionButton("mine", "My Requests", () => handlers.open({ screen: "mine", cursors: [undefined], index: 0, pendingIndex: undefined, data: undefined })),
    ];
    const body: Body = { content: [], zones: [] };
    const data = screen.data;
    if (data !== undefined) {
        // Brand rows share one "Browse by" zone, placed where the first of them is.
        let brands: { readonly items: FocusItem[]; readonly node: HTMLElement } | undefined;
        for (const ref of data.rowOrder) {
            const kind = BRAND_TYPES.find(type => type === ref.type);
            if (kind !== undefined) {
                const button = actionButton(`brand:${kind}`, ref.title, () => handlers.open({ screen: "brands", brand: kind, title: ref.title, mediaType: "movie", data: undefined }));
                if (brands === undefined) {
                    brands = { items: [], node: el("div", "browse-actions") };
                    body.content.push(el("h2", "browse-section-title", "Browse by"), brands.node);
                    body.zones.push({ id: "brands", layout: "row", items: brands.items });
                }
                brands.items.push(button);
                brands.node.appendChild(button.element);
                continue;
            }
            const row = TITLE_ROWS.includes(ref.type) ? data.items.find(item => item.key === ref.key) : undefined;
            if (row === undefined) continue;
            const cards = mediaCards(row.results, handlers);
            if (cards.length === 0) continue;
            if (nextProviderPage(row) !== undefined && (BUILT_IN_ROWS.includes(row.key) || handlers.status?.discoverRowsSupported === true)) {
                cards.push(actionButton("more", "See all", () => handlers.open({ screen: "results", source: { kind: "row", key: row.key }, title: row.title, pages: providerPages() })));
            }
            const section = el("section", "requests-row");
            section.setAttribute("data-section", row.key);
            section.append(el("h2", "browse-section-title", row.title), zoneNode("browse-row", cards));
            body.content.push(section);
            body.zones.push({ id: `row:${row.key}`, layout: "row", items: cards });
        }
        if (body.zones.length === 0) body.content.push(...lines(["Nothing to discover right now. Search for a title instead."]));
    }
    return frame("requests:hub", "Requests", controls, body, handlers, data !== undefined);
}

function brandsView(screen: Extract<RequestsScreen, { screen: "brands" }>, handlers: RequestsHandlers): View {
    const body: Body = { content: [], zones: [] };
    if (screen.brand === "genres") {
        const filters = (["movie", "series"] as const).map(type => {
            const item = actionButton(`type:${type}`, type === "movie" ? "Movies" : "Series", () => handlers.mediaType(type));
            item.element.setAttribute("aria-pressed", String(screen.mediaType === type));
            return item;
        });
        body.content.push(zoneNode("skyline-pills", filters));
        body.zones.push({ id: "filters", layout: "row", items: filters });
    }
    if (screen.data !== undefined) {
        const shown = screen.brand === "genres" && screen.mediaType === "series" ? screen.data.filter(brand => brand.seriesSupported !== false) : screen.data;
        const brands = shown.map(brand => actionButton(`brand:${brand.slug}`, brand.displayName, () => handlers.open({
            screen: "results", title: brand.displayName, pages: providerPages(),
            source: { kind: "brand", brand: screen.brand === "genres" ? { kind: "genres", slug: brand.slug, mediaType: screen.mediaType } : { kind: screen.brand, slug: brand.slug } },
        })));
        if (brands.length === 0) body.content.push(...lines(["Nothing to browse here."]));
        body.content.push(zoneNode("browse-actions requests-brands", brands));
        body.zones.push({ id: "grid", layout: "grid", columns: 4, items: brands });
    }
    return frame(`requests:brands:${screen.brand}`, screen.title, backButton(handlers), body, handlers, screen.data !== undefined, "grid");
}

function detailView(screen: Extract<RequestsScreen, { screen: "detail" }>, handlers: RequestsHandlers): View {
    const detail = screen.data;
    const controls: FocusItem[] = [];
    const body: Body = { content: [], zones: [] };
    if (detail !== undefined) {
        const choices = requestChoices(detail, handlers.status);
        const action = (key: RequestAction, label: string): void => {
            const pending = screen.pending === key;
            const item = actionButton(key, pending ? PENDING[key] : label, () => handlers.act(key));
            if (screen.pending !== undefined) item.element.setAttribute("aria-disabled", "true");
            if (pending) item.element.setAttribute("aria-busy", "true");
            controls.push(item);
        };
        const library = detail.libraryContentId;
        if (library !== undefined && detail.availability === "available") controls.push(actionButton("library", "Open in library", () => handlers.openItem(library, detail.title)));
        if (choices.request || screen.pending === "create") action("create", "Request");
        if (choices.cancel || screen.pending === "cancel") action("cancel", "Cancel request");
        if (choices.follow || screen.pending === "follow") action("follow", "Follow");
        if (choices.unfollow || screen.pending === "unfollow") action("unfollow", "Unfollow");
        const meta = [detail.year === undefined || detail.year === 0 ? undefined : String(detail.year), detail.mediaType === "series" ? "Series" : "Movie",
            detail.runtime === undefined || detail.runtime === 0 ? undefined : `${detail.runtime} min`, detail.contentRating, detail.genres.join(", "),
            detail.mediaType === "series" && detail.seasons.length > 0 ? `${detail.seasons.length} ${detail.seasons.length === 1 ? "season" : "seasons"}` : undefined];
        const state = mediaStateLabel(detail.availability, detail.request);
        const notice = screen.notice;
        body.content.push(artwork("browse-art requests-poster", posterUrl(detail.posterPath), handlers.baseUrl, detail.title), ...lines([meta.filter(part => part !== undefined && part !== "").join(" · ")]),
            ...(state === undefined ? [] : lines([state])), ...(notice === undefined ? [] : lines([notice.text], notice.tone)),
            ...(detail.tagline ? lines([detail.tagline]) : []), ...(detail.overview ? lines([detail.overview]) : []));
    }
    controls.push(...backButton(handlers));
    return frame(`requests:detail:${screen.mediaType}:${screen.tmdbId}`, detail?.title ?? screen.title, controls, body, handlers, detail !== undefined);
}

function mineView(screen: Extract<RequestsScreen, { screen: "mine" }>, handlers: RequestsHandlers): View {
    const body: Body = { content: [], zones: [] };
    const data = screen.data;
    if (data !== undefined) {
        const cards = data.items.map(request => requestCard(request, handlers));
        const pager: FocusItem[] = [];
        if (screen.index > 0) pager.push(actionButton("previous", "Previous page", () => handlers.turn(-1)));
        if (data.nextCursor !== undefined) pager.push(actionButton("next", "Next page", () => handlers.turn(1)));
        if (cards.length === 0) body.content.push(...lines(["You have not requested anything yet."]));
        body.content.push(zoneNode("browse-grid", cards), zoneNode("browse-actions", pager));
        body.zones.push({ id: "grid", layout: "grid", columns: GRID_COLUMNS, items: cards }, { id: "pager", layout: "row", items: pager });
    }
    return frame("requests:mine", "My Requests", backButton(handlers), body, handlers, data !== undefined);
}

function searchView(screen: Extract<RequestsScreen, { screen: "search" }>, handlers: RequestsHandlers): View {
    const label = el("label", "browse-label", "Search for a movie or series to request");
    label.htmlFor = handlers.input.id;
    const field: FocusItem = { key: "query", element: handlers.input };
    const content: HTMLElement[] = [el("h1", "browse-title", "Search requests"), label, handlers.input];
    const zones: Zone[] = [{ id: "field", layout: "row", items: [field] }];
    const submitted = screen.submitted;
    if (handlers.failure !== undefined) {
        const retry = actionButton("retry", "Try again", handlers.retry);
        content.push(...lines([handlers.failure], "error"), zoneNode("browse-actions", [retry]));
        zones.push({ id: "status", layout: "row", items: [retry] });
    } else if (submitted !== undefined && (screen.pages.data === undefined || handlers.busy && screen.pages.want === undefined)) {
        content.push(...lines([handlers.slow ? "Still waiting for the server." : "Searching."]));
    }
    if (submitted !== undefined) {
        const results = pagedResults(screen.pages, `No results for "${submitted}".`, handlers);
        content.push(...results.content);
        zones.push(...results.zones);
    }
    return { name: "requests:search", content, zones, focus: { zone: "field", key: "query" }, back: handlers.back };
}

export function requestsView(screen: RequestsScreen, handlers: RequestsHandlers): View {
    switch (screen.screen) {
        case "hub":
            return hubView(screen, handlers);
        case "results":
            return frame(`requests:results:${screen.source.kind === "row" ? screen.source.key : `${screen.source.brand.kind}:${screen.source.brand.slug}`}`, screen.title, backButton(handlers),
                pagedResults(screen.pages, "No titles here.", handlers), handlers, screen.pages.data !== undefined, "grid");
        case "search":
            return searchView(screen, handlers);
        case "brands":
            return brandsView(screen, handlers);
        case "detail":
            return detailView(screen, handlers);
        case "mine":
            return mineView(screen, handlers);
        default: {
            const never: never = screen;
            throw new Error(`Unhandled Requests screen ${String(never)}`);
        }
    }
}
