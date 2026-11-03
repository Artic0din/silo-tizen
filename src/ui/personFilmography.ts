import type { CatalogQueryRequest, MediaScope } from "../contracts/v2/discovery.ts";
import type { View, Zone } from "./browseFocus.ts";
import { PAGE_SIZE, type Route, type RouteHandlers } from "./browseRoutes.ts";
import { actionButton, lines, pagedGrid, zoneNode } from "./browseViews.ts";
import { personHero } from "./browseDetails.ts";
import { el } from "./screen.ts";

export function personQuery(id: string, filter: MediaScope, cursor?: string): CatalogQueryRequest {
    return { source: "person", person_id: id, type: filter, sort: "year", order: "desc", limit: PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) };
}

export function personFilmographyView(route: Extract<Route, { kind: "person" }>, handlers: RouteHandlers): View {
    const actions = [];
    if (route.failure !== undefined) actions.push(actionButton("retry", "Try again", () => handlers.retry(route)));
    const filters = (["video", "movie", "series"] as const).map(filter => {
        const item = actionButton(`filter:${filter}`, filter === "video" ? "All" : filter === "movie" ? "Movies" : "Series", () => handlers.personFilter(route, filter));
        item.element.setAttribute("aria-pressed", String(route.filter === filter));
        return item;
    });
    const title = el("div", "person-filmography-heading");
    title.appendChild(el("h2", "browse-section-title", "Filmography"));
    const page = route.pages.page;
    if (page !== undefined) title.appendChild(el("span", "person-title-count", `${page.totalExact ? "" : "About "}${page.total} ${page.total === 1 ? "title" : "titles"}`));
    const content = [...(route.data === undefined ? [] : [personHero(route.data.person, handlers.context.baseUrl)]), title, zoneNode("skyline-pills person-filmography-filters", filters), ...(actions.length === 0 ? [] : [zoneNode("browse-actions", actions)])];
    const zones: Zone[] = [{ id: "filters", layout: "row", items: filters }, { id: "actions", layout: "row", items: actions }];
    if (route.failure !== undefined) content.push(...lines([route.failure], "error"));
    if (page !== undefined) {
        if (page.items.length === 0) content.push(...lines(["No available titles for this filter."]));
        const grid = pagedGrid({ page, index: route.pages.index, pageSize: PAGE_SIZE, loading: handlers.busy, previous: () => handlers.turn(route, route.pages, -1), next: () => handlers.turn(route, route.pages, 1) }, handlers.context);
        content.push(...grid.content);
        zones.push(...grid.zones);
    } else if (handlers.busy || route.failure === undefined) {
        const loading = el("p", "browse-text", route.slow ? "Still waiting for the server." : "Loading");
        loading.setAttribute("role", "status");
        content.push(loading);
    }
    const first = zones.find(zone => zone.id === "grid")?.items[0];
    return { name: `person:${route.id}`, content, zones,
        focus: first === undefined ? { zone: "filters", key: `filter:${route.filter}` } : { zone: "grid", key: first.key }, back: handlers.pop };
}
