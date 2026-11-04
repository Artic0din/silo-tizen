import type { RequestSpec } from "../api/http.ts";
import { operations } from "../api/operations.ts";
import type { CatalogQueryRequest } from "../contracts/v2/discovery.ts";
import { boolean, object, string } from "../contracts/v2/wire.ts";
import type { FocusItem, View, Zone } from "./browseFocus.ts";
import { PAGE_SIZE, type Route, type RouteHandlers } from "./browseRoutes.ts";
import { actionButton, lines, pagedGrid, zoneNode } from "./browseViews.ts";
import { navigationIcon } from "./navigationIcon.ts";
import { el } from "./screen.ts";

export type PersonalSource = "watchlist" | "favorites" | "history";
export type PersonalFilter = "movie" | "series" | "episode";
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
    return { source, type: source === "history" ? (filter === "episode" ? "episode" : "video") : source === "favorites" ? filter : "video", limit: PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) };
}
export function readPersonalPage(source: PersonalSource, filter: PersonalFilter, cursor: string | undefined): ReturnType<typeof operations.queryCatalogItems> {
    return operations.queryCatalogItems(personalQuery(source, filter, cursor));
}
/** Apple tvOS WatchlistView / FavoritesView: eight 176-point posters. History keeps the catalog grid. */
const DENSE_COLUMNS = 8;

function statusOwner(className: string, label: string, text?: string): FocusItem {
    const element = el("button", className, text);
    element.type = "button";
    element.setAttribute("data-focus", "status");
    element.setAttribute("aria-label", label);
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

function savedFilters(route: Extract<Route, { kind: "personal" }>, handlers: RouteHandlers): FocusItem[] {
    return (["movie", "series"] as const).map(filter => {
        const item = actionButton(`filter:${filter}`, filter === "movie" ? "Movies" : "TV Shows", () => handlers.personalFilter(route, filter));
        item.element.setAttribute("aria-pressed", String(route.filter === filter));
        return item;
    });
}

/** Watchlist and Favorites, from Apple's tvOS grids at silo-apple 9723df0. */
function savedListView(route: Extract<Route, { kind: "personal" }>, handlers: RouteHandlers): View {
    const title = PERSONAL_TITLES[route.source];
    const page = route.pages.page;
    const blocked = route.capability !== undefined && (!route.capability.allowed || route.capability.state !== "available");
    const content: HTMLElement[] = [];
    const zones: Zone[] = [];
    const retry = route.failure === undefined ? undefined : actionButton("retry", "Try Again", () => handlers.retry(route));
    if (route.failure !== undefined && page === undefined) {
        content.push(...lines([route.failure], "error"));
        if (retry !== undefined) {
            content.push(zoneNode("browse-actions", [retry]));
            zones.push({ id: "actions", layout: "row", items: [retry] });
        }
    } else if (blocked) {
        const status = statusOwner("personal-status", `${title} is unavailable.`, `${title} is unavailable.`);
        content.push(status.element);
        zones.push({ id: "status", layout: "row", items: [status] });
    } else if (page === undefined) {
        const status = statusOwner("personal-loading", route.source === "watchlist" ? "Loading watchlist" : "Loading favorites");
        content.push(status.element);
        zones.push({ id: "status", layout: "row", items: [status] });
    } else if (page.items.length === 0 && route.source === "watchlist") {
        const status = emptyOwner("Watchlist is empty", "Tap the bookmark icon on any item to add it here", "watchlist");
        content.push(status.element);
        zones.push({ id: "status", layout: "row", items: [status] });
    } else {
        content.push(el("h1", "browse-title", title));
        if (route.source === "favorites") {
            const filters = savedFilters(route, handlers);
            content.push(zoneNode("personal-filters", filters));
            zones.push({ id: "filters", layout: "row", items: filters });
        }
        if (page.items.length === 0) content.push(sectionEmpty(route.filter));
        else {
            const grid = pagedGrid({ page, index: route.pages.index, pageSize: PAGE_SIZE, loading: handlers.busy, previous: () => handlers.turn(route, route.pages, -1), next: () => handlers.turn(route, route.pages, 1) }, handlers.context, DENSE_COLUMNS);
            grid.content[0]?.classList.add("personal-grid");
            content.push(...grid.content);
            zones.push(...grid.zones);
        }
        if (route.failure !== undefined) content.push(...lines([route.failure], "error"));
        if (retry !== undefined) {
            content.push(zoneNode("browse-actions", [retry]));
            zones.push({ id: "actions", layout: "row", items: [retry] });
        }
    }
    const filters = zones.find(zone => zone.id === "filters" && zone.items.length > 0);
    const grid = zones.find(zone => zone.id === "grid" && zone.items.length > 0);
    const preferred = route.source === "favorites" && page !== undefined && route.failure === undefined ? filters : grid;
    const zone = preferred ?? zones.find(candidate => candidate.items.length > 0);
    const item = zone?.id === "filters" ? zone.items.find(candidate => candidate.key === `filter:${route.filter}`) ?? zone.items[0] : zone?.items[0];
    const pageNode = el("div", "personal-page");
    pageNode.append(...content);
    return { name: `personal:${route.source}`, content: [pageNode], zones, focus: zone === undefined || item === undefined ? undefined : { zone: zone.id, key: item.key }, back: handlers.pop };
}

export function personalView(route: Extract<Route, { kind: "personal" }>, handlers: RouteHandlers): View {
    if (route.source === "watchlist" || route.source === "favorites") return savedListView(route, handlers);
    if (route.source !== "history") {
        const unexpected: never = route.source;
        throw new Error(unexpected);
    }
    const title = PERSONAL_TITLES[route.source];
    const controls = [actionButton("back", "Back", handlers.pop)];
    if (route.failure !== undefined) controls.push(actionButton("retry", "Try again", () => handlers.retry(route)));
    const content = [el("h1", "browse-title", title), zoneNode("browse-actions", controls)];
    const zones: Zone[] = [{ id: "actions", layout: "row", items: controls }];
    const choices: readonly PersonalFilter[] = ["movie", "episode"];
    const filters = choices.map(filter => {
        const label = filter === "episode" ? "Episodes" : "Movies & TV Shows";
        const item = actionButton(`filter:${filter}`, label, () => handlers.personalFilter(route, filter));
        item.element.setAttribute("aria-pressed", String(route.filter === filter));
        return item;
    });
    content.push(zoneNode("skyline-pills", filters));
    zones.push({ id: "filters", layout: "row", items: filters });
    if (route.failure !== undefined) content.push(...lines([route.failure], "error"));
    if (route.pages.page !== undefined) {
        if (route.pages.page.items.length === 0) content.push(...lines([`No ${title.toLowerCase()}`]));
        const grid = pagedGrid({ page: route.pages.page, index: route.pages.index, pageSize: PAGE_SIZE, loading: handlers.busy, previous: () => handlers.turn(route, route.pages, -1), next: () => handlers.turn(route, route.pages, 1) }, handlers.context);
        content.push(...grid.content);
        zones.push(...grid.zones);
    } else if (handlers.busy || route.failure === undefined) {
        const loading = el("p", "browse-text", "Loading");
        loading.setAttribute("role", "status");
        content.push(loading);
    }
    const first = zones.find(zone => zone.id === "grid" && zone.items.length > 0) ?? zones.find(zone => zone.id === "filters") ?? zones[0];
    const item = first?.items[0];
    return { name: `personal:${route.source}`, content, zones, focus: item === undefined ? undefined : { zone: first?.id ?? "actions", key: item.key }, back: handlers.pop };
}
