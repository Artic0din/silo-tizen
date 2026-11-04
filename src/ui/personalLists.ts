import type { RequestSpec } from "../api/http.ts";
import { operations } from "../api/operations.ts";
import { decodeCard, type CatalogPage } from "../contracts/v2/catalog.ts";
import type { CatalogQueryRequest } from "../contracts/v2/discovery.ts";
import { boolean, object, string, WireError } from "../contracts/v2/wire.ts";
import type { FocusItem, View, Zone } from "./browseFocus.ts";
import type { ErrorState } from "./browseRoutes.ts";
import { PAGE_SIZE, type Route, type RouteHandlers } from "./browseRoutes.ts";
import { actionButton, FAILURE_ICON, recoveryActions, searchState, zoneNode } from "./browseViews.ts";
import { feedGrid } from "./catalogFeed.ts";
import { navigationIcon } from "./navigationIcon.ts";
import { el } from "./screen.ts";

export type PersonalSource = "watchlist" | "favorites" | "history";
export type PersonalFilter = "movie" | "series";
export const PERSONAL_TITLES = { watchlist: "Watchlist", favorites: "Favorites", history: "History" };
export interface PersonalListCapability {
    readonly state: string;
    readonly allowed: boolean;
    readonly membershipSupported: boolean;
}
export function decodePersonalListCapability(value: unknown): PersonalListCapability {
    const obj = object(value, "personal_lists");
    string(obj, "revision", "personal_lists");
    return { state: string(obj, "state", "personal_lists"), allowed: boolean(obj, "allowed", "personal_lists"), membershipSupported: boolean(obj, "membership_supported", "personal_lists") };
}
export function personalListCapability(): RequestSpec<PersonalListCapability> {
    return { method: "GET", path: "/capabilities/personal-lists", retry: "safe", decode: decodePersonalListCapability };
}
export function personalQuery(source: PersonalSource, filter: PersonalFilter, cursor?: string): CatalogQueryRequest {
    // Omit sort/order: each source's native default defines the fenced ordering.
    return { source, ...(source === "history" ? {} : { type: source === "favorites" ? filter : "video" }), limit: source === "history" ? 60 : PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) };
}
export function readPersonalPage(source: PersonalSource, filter: PersonalFilter, cursor: string | undefined): RequestSpec<CatalogPage> {
    if (source === "history") return operations.queryCatalogItems(personalQuery(source, filter, cursor));
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), image_size: "small" });
    if (cursor !== undefined) params.set("cursor", cursor);
    return { method: "GET", path: `/${source}?${params}`, retry: "safe", decode: value => {
        const obj = object(value, "personal_list");
        if (!Array.isArray(obj.items)) throw new WireError("personal_list.items", "an array");
        const page = object(obj.page, "personal_list.page");
        const more = boolean(page, "has_more", "personal_list.page");
        const nextCursor = more ? string(page, "next_cursor", "personal_list.page") : undefined;
        if (nextCursor === "") throw new WireError("personal_list.page.next_cursor", "a nonempty continuation");
        const cards = obj.items.map((item, index) => decodeCard(item, `personal_list.items[${index}]`));
        // Apple's FavoritesView filters the stored list without changing its order.
        const items = source === "favorites" ? cards.filter(card => filter === "movie" ? card.type === "movie" : card.type === "series" || card.type === "episode") : cards;
        return { items, nextCursor, total: items.length, totalExact: false };
    } };
}

/** CatalogGrid.loadMoreLead: the card this far from the end asks for the next page. */
const LOAD_LEAD = 6;
/** Apple tvOS WatchlistView / FavoritesView: eight 176-point posters in a 1760-point safe width. */
const DENSE_COLUMNS = 8;
const DENSE_WIDTH = 1760;
const DENSE_POSTER = 176;
/** History adds 48-point content padding inside the TV's 80-point safe area. */
const HISTORY_COLUMNS = 6;
const HISTORY_WIDTH = 1664;

type PersonalRoute = Extract<Route, { kind: "personal" }>;

function statusOwner(className: string, label: string, text?: string): FocusItem {
    const element = el("button", className, text);
    element.type = "button";
    element.setAttribute("data-focus", "status");
    if (label !== "") element.setAttribute("aria-label", label);
    return { key: "status", element };
}

function emptyOwner(title: string, subtitle: string, icon: string): FocusItem {
    const owner = statusOwner("personal-empty", title);
    const mark = navigationIcon(icon);
    mark.classList.add("personal-empty-icon");
    owner.element.append(mark, el("span", "personal-empty-title", title), el("span", "personal-empty-subtitle", subtitle));
    return owner;
}

function sectionEmpty(filter: PersonalFilter): HTMLElement {
    const node = el("div", "personal-section-empty");
    const mark = navigationIcon(filter === "series" ? "series" : "movies");
    mark.classList.add("personal-section-icon");
    const name = filter === "series" ? "tv shows" : "movies";
    node.append(mark, el("p", "personal-section-title", `No favorite ${name}`), el("p", "personal-section-subtitle", "Add favorites from any detail page and they will appear here."));
    return node;
}

function savedFilters(route: PersonalRoute, handlers: RouteHandlers): FocusItem[] {
    return (["movie", "series"] as const).map(filter => {
        const item = actionButton(`filter:${filter}`, filter === "movie" ? "Movies" : "TV Shows", () => handlers.personalFilter(route, filter));
        item.element.setAttribute("aria-pressed", String(route.filter === filter));
        return item;
    });
}

/** Apple ErrorView, the same recovery plan the Requests hub uses. */
function errorPage(route: PersonalRoute, handlers: RouteHandlers): View {
    const error: ErrorState = route.error ?? { headline: "Something went wrong", message: route.failure ?? "", signIn: false };
    const page = searchState(error.headline, error.message, "personal-failure", FAILURE_ICON);
    page.setAttribute("role", "alert");
    const items = recoveryActions(
        error,
        actionButton("retry", "Try Again", () => handlers.retry(route)),
        actionButton("go-back", "Go Back", handlers.pop),
        handlers.signIn === undefined ? undefined : actionButton("sign-in", "Sign In Again", handlers.signIn),
    );
    page.appendChild(zoneNode("browse-actions", items));
    const pageNode = el("div", "personal-page");
    pageNode.append(page);
    return { name: `personal:${route.source}`, content: [pageNode], zones: [{ id: "status", layout: "column", items }], focus: { zone: "status", key: items[0]?.key ?? "retry" }, back: handlers.pop };
}

function shownError(route: PersonalRoute, page: CatalogPage | undefined): boolean {
    return (route.failure !== undefined || route.error !== undefined) && (page === undefined || page.items.length === 0);
}

/** HistoryViewModel.countLabel: the exact total, or a lower bound while another page remains. */
function historyCount(page: CatalogPage): string {
    const count = page.totalExact ? page.total : page.items.length;
    const lowerBound = !page.totalExact && page.nextCursor !== undefined;
    return `${count}${lowerBound ? "+" : ""} ${count === 1 && !lowerBound ? "item" : "items"}`;
}

function continuousGrid(route: PersonalRoute, handlers: RouteHandlers, columns: number, posterWidth: number, gridWidth: number): { content: HTMLElement[]; zones: Zone[] } {
    const page = route.pages.page;
    if (page === undefined) return { content: [], zones: [] };
    const { preview, ...context } = handlers.context;
    void preview;
    const grid = feedGrid(route.pages, page, context, LOAD_LEAD, handlers.busy, () => handlers.morePersonal(route), columns, posterWidth, gridWidth);
    if (posterWidth === DENSE_POSTER) grid.content[0]?.classList.add("personal-grid");
    return grid;
}

/** Watchlist and Favorites, from Apple's tvOS grids at silo-apple 9723df0. One scrolling grid, like CatalogGrid's append path. */
function savedListView(route: PersonalRoute, handlers: RouteHandlers): View {
    const title = PERSONAL_TITLES[route.source];
    const page = route.pages.page;
    const blocked = route.capability !== undefined && (!route.capability.allowed || route.capability.state !== "available");
    if (!blocked && shownError(route, page)) return errorPage(route, handlers);
    const content: HTMLElement[] = [];
    const zones: Zone[] = [];
    const wholeEmpty = page !== undefined && page.items.length === 0 && (route.source === "watchlist" || route.elsewhere !== true);
    if (blocked) {
        const status = statusOwner("personal-status", `${title} is unavailable.`, `${title} is unavailable.`);
        content.push(status.element);
        zones.push({ id: "status", layout: "row", items: [status] });
    } else if (page === undefined) {
        const status = statusOwner("personal-loading", route.source === "watchlist" ? "Loading watchlist" : "Loading favorites");
        content.push(status.element);
        zones.push({ id: "status", layout: "row", items: [status] });
    } else if (wholeEmpty) {
        const copy = route.source === "watchlist"
            ? { title: "Watchlist is empty", subtitle: "Tap the bookmark icon on any item to add it here", icon: "watchlist" }
            : { title: "No favorites", subtitle: "Tap the heart icon on any item to add it here", icon: "favorites" };
        const status = emptyOwner(copy.title, copy.subtitle, copy.icon);
        content.push(status.element);
        zones.push({ id: "status", layout: "row", items: [status] });
    } else {
        content.push(el("h1", "browse-title", title));
        if (route.source === "favorites") {
            const filters = savedFilters(route, handlers);
            content.push(zoneNode("personal-filters", filters));
            zones.push({ id: "filters", layout: "row", down: "grid", items: filters });
        }
        if (page.items.length === 0) content.push(sectionEmpty(route.filter));
        else {
            const grid = continuousGrid(route, handlers, DENSE_COLUMNS, DENSE_POSTER, DENSE_WIDTH);
            content.push(...grid.content);
            zones.push(...grid.zones.map(zone => ({ ...zone, ...(route.source === "favorites" ? { up: "filters" } : {}) })));
        }
    }
    const filters = zones.find(zone => zone.id === "filters" && zone.items.length > 0);
    const grid = zones.find(zone => zone.id === "grid" && zone.items.length > 0);
    const preferred = route.source === "favorites" && page !== undefined && route.failure === undefined && route.error === undefined ? filters : grid;
    const zone = preferred ?? zones.find(candidate => candidate.items.length > 0);
    const item = zone?.id === "filters" ? zone.items.find(candidate => candidate.key === `filter:${route.filter}`) ?? zone.items[0] : zone?.items[0];
    const pageNode = el("div", "personal-page");
    return { name: `personal:${route.source}`, prepare: () => pageNode.append(...content), content: [pageNode], zones, focus: zone === undefined || item === undefined ? undefined : { zone: zone.id, key: item.key }, back: handlers.pop };
}

/** HistoryView: a pushed catalog grid with a count, not the dense personal grid. */
function historyView(route: PersonalRoute, handlers: RouteHandlers): View {
    const page = route.pages.page;
    if (shownError(route, page)) return errorPage(route, handlers);
    const content: HTMLElement[] = [];
    const zones: Zone[] = [];
    if (page === undefined) {
        const status = statusOwner("personal-loading", "");
        content.push(status.element);
        zones.push({ id: "status", layout: "row", items: [status] });
    } else if (page.items.length === 0) {
        const status = emptyOwner("No watch history", "Items you watch will appear here", "history");
        content.push(status.element);
        zones.push({ id: "status", layout: "row", items: [status] });
    } else {
        const count = el("p", "personal-count", historyCount(page));
        const columns = (handlers.context.posterScale?.() ?? 1) > 1 ? 5 : HISTORY_COLUMNS;
        const grid = continuousGrid(route, handlers, columns, 260, HISTORY_WIDTH);
        content.push(count, ...grid.content);
        zones.push(...grid.zones);
    }
    const zone = zones.find(candidate => candidate.items.length > 0);
    const item = zone?.items[0];
    const pageNode = el("div", "personal-page");
    return { name: "personal:history", prepare: () => pageNode.append(...content), content: [pageNode], zones, focus: zone === undefined || item === undefined ? undefined : { zone: zone.id, key: item.key }, back: handlers.pop };
}

export function personalView(route: PersonalRoute, handlers: RouteHandlers): View {
    if (route.source === "watchlist" || route.source === "favorites") return savedListView(route, handlers);
    if (route.source !== "history") {
        const unexpected: never = route.source;
        throw new Error(unexpected);
    }
    const view = historyView(route, handlers);
    view.content[0]?.classList.add("skyline-content");
    return { ...view, content: [el("h1", "browse-title section-catalog-title", "History"), ...view.content] };
}
