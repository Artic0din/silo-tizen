import type { RequestSpec } from "../api/http.ts";
import { operations } from "../api/operations.ts";
import type { CatalogQueryRequest } from "../contracts/v2/discovery.ts";
import { boolean, object, string } from "../contracts/v2/wire.ts";
import type { View, Zone } from "./browseFocus.ts";
import { PAGE_SIZE, type Route, type RouteHandlers } from "./browseRoutes.ts";
import { actionButton, lines, pagedGrid, zoneNode } from "./browseViews.ts";
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
export function personalView(route: Extract<Route, { kind: "personal" }>, handlers: RouteHandlers): View {
    const title = PERSONAL_TITLES[route.source];
    const controls = [actionButton("back", "Back", handlers.pop)];
    if (route.failure !== undefined) controls.push(actionButton("retry", "Try again", () => handlers.retry(route)));
    const content = [el("h1", "browse-title", title), zoneNode("browse-actions", controls)];
    const zones: Zone[] = [{ id: "actions", layout: "row", items: controls }];
    if (route.source === "favorites" || route.source === "history") {
        const choices: readonly PersonalFilter[] = route.source === "history" ? ["movie", "episode"] : ["movie", "series"];
        const filters = choices.map(filter => {
            const label = filter === "episode" ? "Episodes" : route.source === "history" ? "Movies & TV Shows" : filter === "movie" ? "Movies" : "TV Shows";
            const item = actionButton(`filter:${filter}`, label, () => handlers.personalFilter(route, filter));
            item.element.setAttribute("aria-pressed", String(route.filter === filter));
            return item;
        });
        content.push(zoneNode("skyline-pills", filters));
        zones.push({ id: "filters", layout: "row", items: filters });
    }
    if (route.failure !== undefined) content.push(...lines([route.failure], "error"));
    if (route.capability !== undefined && (!route.capability.allowed || route.capability.state !== "available")) {
        content.push(...lines([`${title} is unavailable.`]));
    } else if (route.pages.page !== undefined) {
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
